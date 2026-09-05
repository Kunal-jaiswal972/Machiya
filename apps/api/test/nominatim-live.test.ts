import { beforeAll, describe, expect, it } from 'vitest';
import { env } from '../src/env.js';

/**
 * Tier 2, against the real Nominatim — the coverage `known-issues.md` recorded
 * as missing.
 *
 * Every other suite stubs this adapter, and that is the right call for what
 * they test: the gating, the merge and the ranking are ours, and Nominatim is
 * not. But **three bugs got through precisely because of it** — D57 (the API
 * was pointed at a public instance that 403s our contact string, and the
 * adapter degraded silently), D58 (the house-number retry, whose whole value is
 * what a real geocoder does with a stripped query), and D60 (the score mapping,
 * which was wrong because real `importance` values cluster far lower than any
 * fixture would).
 *
 * So this file re-runs the measurements those entries record, against the
 * instance the app is actually configured to talk to. It skips itself — loudly
 * — when the geo profile is down, the same way `geo-boundary.test.ts` does.
 *
 * These assertions are deliberately about SHAPE rather than exact rows. OSM
 * data moves; what must not move is that the adapter reaches a geocoder, reads
 * the fields that geocoder actually sends, and never claims more precision than
 * it earned.
 *
 * **The cache is flushed first, and that is not housekeeping.** The provider
 * caches every lookup in Redis for seven days, so without this the whole file
 * can pass from cache and prove nothing whatever about the upstream — a live
 * test that never goes live. Found by pointing it at the public instance, which
 * 403s our contact string: it still passed, because the answers were already in
 * Redis from a local run.
 *
 * The flush goes through `cacheDeleteMatching`, which awaits the same
 * connection every other cache operation does — a `scan` issued straight at the
 * client rejects on a fresh process, because that client is deliberately
 * fail-fast with no offline queue (D21, D46).
 */

const FIX = 'pnpm bootstrap && docker compose --profile geo up -d';

async function nominatimUp(): Promise<boolean> {
  try {
    const url = new URL('/status', env.NOMINATIM_URL);
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return response.ok;
  } catch {
    return false;
  }
}

const up = await nominatimUp();

if (!up) {
  console.warn(`nominatim-live: Nominatim is not answering — skipping. Fix: ${FIX}`);
}

/** The real adapter, not the module every other suite replaces. */
async function provider() {
  const { resolveGeocodeProvider } = await import('../src/geo/nominatim.js');
  return resolveGeocodeProvider();
}

beforeAll(async () => {
  if (!up) return;
  // Every cached geocode answer, so each assertion below really asks Nominatim.
  const { cacheDeleteMatching } = await import('../src/lib/cache.js');
  await cacheDeleteMatching('*geocode*');
});

describe.skipIf(!up)('the geocode adapter against a live Nominatim', () => {
  /**
   * The D57 class: a configured geocoder that refuses.
   *
   * `.env` pointed at the public instance, which answers 403 to the contact
   * string the file itself tells you to replace. The adapter degrades silently
   * on a refusal — by design — so every landmark query returned an empty
   * dropdown and nothing in the suite noticed. `refused` is the field that
   * tells "the provider could not answer" from "the answer is empty".
   *
   * This catches a refusing upstream, whatever the reason. It does NOT
   * distinguish the local instance from a public one that happens to answer, so
   * it is not a substitute for reading `NOMINATIM_URL`.
   */
  it('reaches the configured instance and is not refused', async () => {
    const outcome = await (await provider()).search('Golghar, Patna');

    expect(
      outcome.refused,
      `NOMINATIM_URL (${env.NOMINATIM_URL}) refused the request — a public instance will 403 the placeholder contact, see D57`,
    ).toBe(false);
    expect(outcome.results.length).toBeGreaterThan(0);
  });

  /**
   * D60's second and third bugs: the score range, and the field rename.
   *
   * Nominatim's own `importance` clusters very low — an ordinary residential
   * road is around 0.05 — so the old mapping floored results BELOW trigram
   * noise and tier 1's weak matches beat the tier that actually knew the
   * answer. The range is lifted to 0.25-0.90 and must stay monotonic rather
   * than clipped, or an alphabetical tiebreak starts picking winners.
   */
  it('maps importance into the comparable range, without clipping it flat', async () => {
    const outcome = await (await provider()).search('Boring Road, Patna', { limit: 8 });

    expect(outcome.refused).toBe(false);
    expect(outcome.results.length).toBeGreaterThan(0);

    for (const result of outcome.results) {
      expect(result.score).toBeGreaterThanOrEqual(0.25);
      expect(result.score).toBeLessThanOrEqual(0.9);
      expect(result.source).toBe('nominatim');
    }

    // jsonv2 renamed `class` to `category`. Reading only the old name sent
    // every result down the `poi` branch, so a suburb was classified as a shop.
    // If that regressed, every kind here would be the same fallback value.
    const kinds = new Set(outcome.results.map((result) => result.kind));
    expect(
      kinds.has('poi') && kinds.size === 1 && outcome.results.length > 2,
      'every result came back as `poi` — the category/class field is probably unread again (D60)',
    ).toBe(false);
  });

  /**
   * D58, which is the entry with the most measured behaviour behind it and the
   * least testable without a real geocoder.
   *
   * "House 12, Anisabad, Patna" resolves to nothing; "Anisabad, Patna" resolves
   * to the neighbourhood. The adapter therefore retries once with the house
   * number stripped — and **caps the retry at `locality`**, because the house
   * number is gone and even a building hit is not the building that was asked
   * about. That cap is the single rule separating a labelled guess from a
   * confident lie.
   */
  it('answers a house-numbered address by retrying, and never calls it exact', async () => {
    const outcome = await (await provider()).search('House 12, Anisabad, Patna');

    expect(outcome.refused).toBe(false);

    // The retry may still find nothing — that is a real answer about the data,
    // not a failure. What must never happen is a result claiming `exact`.
    for (const result of outcome.results) {
      expect(
        result.matchPrecision,
        `"${result.label}" came back exact for a query whose house number was stripped (D58)`,
      ).not.toBe('exact');
    }

    if (outcome.results.length > 0) {
      // And it should have degraded to something in the right area rather than
      // to an arbitrary road elsewhere in the extract.
      const labels = outcome.results.map((result) => result.label.toLowerCase()).join(' | ');
      const contexts = outcome.results
        .map((result) => (result.context ?? '').toLowerCase())
        .join(' | ');
      expect(
        `${labels} ${contexts}`.includes('anisabad') || `${labels} ${contexts}`.includes('patna'),
        `the stripped retry landed nowhere near the query: ${labels}`,
      ).toBe(true);
    }
  });

  /**
   * D59's premise, which the wizard's location step is built on.
   *
   * Measured at Golghar, reverse geocoding returns the city rather than the
   * building. That is exactly why the wizard prefills a locality only when the
   * match is narrower than `area`, and never prefills a street line. If this
   * ever started returning `exact` for an arbitrary pin, the rule would be
   * over-cautious rather than wrong — but the copy around it would be lying.
   */
  it('says out loud how precise a reverse geocode was', async () => {
    const place = await (await provider()).reverse({ lat: 25.6127, lng: 85.1588 });

    expect(place, 'reverse returned nothing for a point in central Patna').not.toBeNull();
    expect(['exact', 'locality', 'area']).toContain(place?.matchPrecision);
    expect(place?.label.length ?? 0).toBeGreaterThan(0);
  });

  /**
   * The other half of D54: an empty answer is an answer.
   *
   * A query for something genuinely absent must come back `refused: false` with
   * no results, so the service can tell it apart from an outage and show the
   * coverage message rather than "the wider search is unavailable".
   */
  it('reports an empty answer as an answer, not as a failure', async () => {
    const outcome = await (await provider()).search('zzzqqqxxwv nowhere at all');

    expect(outcome.refused).toBe(false);
    expect(outcome.results).toHaveLength(0);
  });

  /**
   * An aborted keystroke counts as refused, deliberately: an abandoned query
   * must not produce a coverage message for something never actually asked.
   */
  it('counts an aborted request as refused rather than as empty', async () => {
    const controller = new AbortController();
    controller.abort();

    const outcome = await (
      await provider()
    ).search('Koramangala', {
      signal: controller.signal,
    });

    expect(outcome.refused).toBe(true);
    expect(outcome.results).toHaveLength(0);
  });
});
