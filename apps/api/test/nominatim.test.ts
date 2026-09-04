import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NominatimGeocodeProvider } from '../src/geo/nominatim.js';

/**
 * The tier 2 adapter, with `fetch` stubbed.
 *
 * What needs proving here is not that Nominatim works — that is measured live
 * and written up in `docs/geo.md` — but that the adapter asks it the right
 * number of questions, in the right form, and does not overstate the answers:
 *
 *  - free text, never a comma-separated structured query;
 *  - **one** retry with the house number stripped, and only on a zero result;
 *  - a retry result can never be `exact`;
 *  - "answered nothing" and "could not answer" stay distinguishable.
 */
interface StubPlace {
  place_id: number;
  lat: string;
  lon: string;
  display_name: string;
  name?: string;
  category?: string;
  type?: string;
  importance?: number;
}

let placeIds = 0;

const suburb = (name: string): StubPlace => ({
  place_id: (placeIds += 1),
  lat: '25.58',
  lon: '85.12',
  display_name: `${name}, Patna, Bihar, India`,
  name,
  category: 'place',
  type: 'suburb',
  importance: 0.3,
});

const building = (name: string): StubPlace => ({
  place_id: (placeIds += 1),
  lat: '25.6',
  lon: '85.14',
  display_name: `${name}, Patna, Bihar, India`,
  name,
  category: 'building',
  type: 'yes',
  importance: 0.3,
});

const road = (name: string): StubPlace => ({
  place_id: (placeIds += 1),
  lat: '25.61',
  lon: '85.11',
  display_name: `${name}, Patna, Bihar, India`,
  name,
  category: 'highway',
  type: 'trunk',
  importance: 0.3,
});

/** Queries the stub answers, keyed by the `q` the adapter actually sends. */
let responses: Map<string, StubPlace[]>;
let requested: string[];
/** When set, every call rejects — the "could not answer" case. */
let failWith: Error | null;

/**
 * A token unique to each test, spliced into every place name.
 *
 * Redis IS running for this suite, and the adapter caches every lookup for
 * seven days under the normalised query. Two tests sharing a query therefore
 * share an answer: the second gets a cache hit, makes no request, and asserts
 * nothing about the adapter. Found the hard way — one test's stubbed empty
 * result satisfied another test's expectation of a failure.
 *
 * Distinct queries are the isolation, rather than flushing a Redis the running
 * dev stack is also using. The caching test below asserts the behaviour this
 * works around, so it is documented rather than merely dodged.
 */
let nonce: string;
let nonceCounter = 0;

/** "Anisabad" becomes "Anisabad q7431", so no two tests collide in Redis. */
const unique = (name: string): string => `${name} ${nonce}`;

beforeEach(() => {
  responses = new Map();
  requested = [];
  failWith = null;
  nonceCounter += 1;
  nonce = `q${String(nonceCounter)}${String(Date.now() % 100_000)}`;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL | string) => {
      const url = input instanceof URL ? input : new URL(input);
      const q = url.searchParams.get('q') ?? '';
      requested.push(q);

      if (failWith) throw failWith;

      return new Response(JSON.stringify(responses.get(q) ?? []), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A fresh provider per test, so no per-instance state can carry over. */
const provider = () => new NominatimGeocodeProvider('http://nominatim.test');

describe('the query it sends', () => {
  it('sends free text, not a comma-separated structured query', async () => {
    const place = unique('Anisabad');
    responses.set(`house 12 ${place.toLowerCase()} patna`, [suburb(place)]);

    const outcome = await provider().search(`House 12, ${place}, Patna`);

    // Commas out, whitespace collapsed. Nominatim matches a comma-separated `q`
    // component by component; free text lets its own fuzzy matching work, and
    // measured across ten real addresses it never did worse.
    expect(requested[0]).toBe(`house 12 ${place.toLowerCase()} patna`);
    expect(outcome.results).toHaveLength(1);
  });
});

describe('the one stripped retry', () => {
  it('asks exactly once when the original query answers', async () => {
    const place = unique('Anisabad');
    responses.set(`${place.toLowerCase()} patna`, [suburb(place)]);

    await provider().search(`${place}, Patna`);

    expect(requested).toEqual([`${place.toLowerCase()} patna`]);
  });

  it('does NOT retry when the query answers WITH the house number in it', async () => {
    // Measured: space-separated queries mostly survive a house number already —
    // "12B Boring Road Patna" finds Boring Road untouched. One call, no strip.
    const place = unique('Boring Road');
    responses.set(`12b ${place.toLowerCase()} patna`, [road(place)]);

    const outcome = await provider().search(`12B ${place} Patna`);

    expect(requested).toHaveLength(1);
    expect(outcome.results).toHaveLength(1);
  });

  it('retries once, with the house number stripped, on a zero result', async () => {
    // The measured case: the full form is absent from the extract, the stripped
    // form is not.
    const place = unique('Anisabad');
    responses.set(`${place.toLowerCase()} patna`, [suburb(place)]);

    const outcome = await provider().search(`House 12, ${place}, Patna`);

    expect(requested).toEqual([
      `house 12 ${place.toLowerCase()} patna`,
      `${place.toLowerCase()} patna`,
    ]);
    expect(outcome.results[0]?.label).toBe(place);
  });

  it('stops after ONE retry rather than truncating until something matches', async () => {
    // Nothing is answerable. Progressive truncation would keep going until
    // Nominatim bit on some fragment — which is how "47 Road 3 Rajendra Nagar"
    // lands on "90 Feet Road", a real road in Patna and not the one asked for.
    const outcome = await provider().search(`House 12, ${unique('Nowhere At All')}, Patna`);

    expect(requested).toHaveLength(2);
    expect(outcome.results).toHaveLength(0);
    expect(outcome.refused).toBe(false);
  });

  it('does not retry when there is no house number to strip', async () => {
    const place = unique('Koramangala');

    await provider().search(place);

    expect(requested).toEqual([place.toLowerCase()]);
  });

  it('caches the outcome under the ORIGINAL query, retry included', async () => {
    // So the same dead-end address costs two upstream calls once, not twice on
    // every keystroke that reaches it.
    const place = unique('Anisabad');
    responses.set(`${place.toLowerCase()} patna`, [suburb(place)]);

    await provider().search(`House 12, ${place}, Patna`);
    expect(requested).toHaveLength(2);

    // A different provider instance, to prove the cache and not a field on the
    // object is doing the work.
    await provider().search(`House 12, ${place}, Patna`);
    expect(requested).toHaveLength(2);
  });
});

describe('what it claims about precision', () => {
  it('caps a retry result at `locality`, even for a building', async () => {
    // The rule that turns a confidently wrong answer into a labelled guess: the
    // house number is gone, so this is not the building that was asked about.
    const place = unique('Anisabad');
    responses.set(`${place.toLowerCase()} patna`, [building(unique('Some Apartment Block'))]);

    const outcome = await provider().search(`House 12, ${place}, Patna`);

    expect(outcome.results[0]?.matchPrecision).toBe('locality');
  });

  it('leaves a direct building match `exact`', async () => {
    const place = unique('Golghar');
    responses.set(`${place.toLowerCase()} patna`, [building(place)]);

    const outcome = await provider().search(`${place} Patna`);

    expect(outcome.results[0]?.matchPrecision).toBe('exact');
  });

  it('calls a road `locality`, because a street is not a house', async () => {
    const place = unique('Bailey Road');
    responses.set(`${place.toLowerCase()} patna`, [road(place)]);

    const outcome = await provider().search(`${place} Patna`);

    expect(outcome.results[0]?.matchPrecision).toBe('locality');
  });

  it('calls a city `area`', async () => {
    const place = unique('Patna');
    responses.set(place.toLowerCase(), [{ ...suburb(place), type: 'city' }]);

    const outcome = await provider().search(place);

    expect(outcome.results[0]?.matchPrecision).toBe('area');
  });

  it('reads `category`, which is what jsonv2 actually sends', async () => {
    // Nominatim renamed `class` to `category`. Reading only `class` would send
    // every result down the POI branch and make a suburb look like a shop.
    const place = unique('Anisabad');
    responses.set(`${place.toLowerCase()} patna`, [suburb(place)]);

    const outcome = await provider().search(`${place}, Patna`);

    expect(outcome.results[0]?.kind).toBe('locality');
    expect(outcome.results[0]?.matchPrecision).toBe('locality');
  });
});

describe('answered nothing versus could not answer', () => {
  it('reports an empty answer as NOT refused', async () => {
    const outcome = await provider().search(unique('Ahmedabad'));

    expect(outcome.results).toHaveLength(0);
    expect(outcome.refused).toBe(false);
  });

  it('reports a failure as refused', async () => {
    failWith = new Error('connect ECONNREFUSED');

    const outcome = await provider().search(unique('Koramangala'));

    expect(outcome.results).toHaveLength(0);
    expect(outcome.refused).toBe(true);
  });
});
