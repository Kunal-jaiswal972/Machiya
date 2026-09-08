import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { prisma } from '@machiya/db';
import { GEO_EPOCH_UNBUILT } from '@machiya/shared/cities';
import { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Against real Postgres, real Redis and a real HTTP server, for the reason the
 * reconciler tests give: the claim under test is that the epoch gate opens once
 * per rebuild and that a partial warm does not close it. Stubbing `fetch` would
 * leave the two things most likely to break — the gate key and what counts as a
 * failed request — asserted against a fake.
 *
 * The stand-in server is not a mock of the API. It is a real server returning
 * the two shapes the job reads, so `fetch`, status handling and the request loop
 * all run for real; only the geo stack behind them is replaced, and that is the
 * dependency rather than the subject.
 */
const GATE_KEY = 'poi-warm:epoch';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: 2,
});

interface Stub {
  server: Server;
  url: string;
  /** Slugs the job asked for, in order. */
  requested: string[];
  /** Slugs to answer 500 for. */
  failFor: Set<string>;
  /** Slugs to answer 429 for. */
  limitFor: Set<string>;
  /** User-Agent headers the stub was called with. */
  agents: string[];
  /** x-internal-token headers the stub was called with. */
  tokens: (string | undefined)[];
  epoch: string;
}

async function startStub(epoch: string): Promise<Stub> {
  const stub = {
    requested: [] as string[],
    failFor: new Set<string>(),
    limitFor: new Set<string>(),
    agents: [] as string[],
    tokens: [] as (string | undefined)[],
    epoch,
  };

  const server = createServer((req, res) => {
    const url = req.url ?? '';

    if (url === '/health/geo') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', epoch: stub.epoch }));
      return;
    }

    const match = /^\/api\/listings\/(.+)\/pois$/.exec(url);
    if (match?.[1]) {
      const slug = decodeURIComponent(match[1]);
      stub.requested.push(slug);
      stub.agents.push(req.headers['user-agent'] ?? '');
      stub.tokens.push(req.headers['x-internal-token'] as string | undefined);

      if (stub.limitFor.has(slug)) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end('{"error":"too many requests"}');
        return;
      }

      if (stub.failFor.has(slug)) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":"boom"}');
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"pois":[]}');
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  // Assigned onto the SAME object the handler closed over, not spread into a new
  // one: a spread copies `epoch` by value and a test that reassigns it would be
  // talking to a server still serving the old value.
  return Object.assign(stub, { server, url: `http://127.0.0.1:${String(port)}` });
}

/**
 * The env module validates once at import, so the stub's port has to be in the
 * environment before the job's module graph is pulled in. A fresh module
 * registry per call is what makes that possible.
 */
async function loadWarmPois(apiUrl: string) {
  process.env.API_INTERNAL_URL = apiUrl;
  process.env.POI_WARM_DELAY_MS = '0';
  vi.resetModules();
  return await import('../src/jobs/warm-pois.js');
}

async function seedListings(slugs: string[]): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE "EnquiryMessage", "Enquiry", "ListingImage", "Listing",
      "Locality", "User", "City" RESTART IDENTITY CASCADE
  `);

  const city = await prisma.city.create({
    data: {
      slug: 'patna',
      name: 'Patna',
      state: 'Bihar',
      centroidLat: 25.5941,
      centroidLng: 85.1376,
      bbox: { minLng: 84.95, minLat: 25.5, maxLng: 85.3, maxLat: 25.68 },
    },
  });

  const owner = await prisma.user.create({
    data: { email: 'lister@test.local', name: 'Lister', emailVerified: true, role: 'EDITOR' },
  });

  // Every column the `listing_complete_when_live` CHECK requires of a non-DRAFT
  // row (D67). A PUBLISHED listing is the only kind this job looks at, so the
  // constraint has to be satisfied rather than worked around.
  for (const [index, slug] of slugs.entries()) {
    await prisma.listing.create({
      data: {
        slug,
        title: `Listing ${slug}`,
        description: 'Seeded for the POI warm test.',
        address: '1 Test Road',
        locality: 'Kankarbagh',
        cityId: city.id,
        ownerId: owner.id,
        status: 'PUBLISHED',
        listingType: 'RENT',
        propertyType: 'APARTMENT',
        furnishing: 'UNFURNISHED',
        bedrooms: 2,
        bathrooms: 1,
        areaSqft: 900,
        lat: 25.59 + index / 1000,
        lng: 85.13 + index / 1000,
        rentAmount: 15000,
      },
    });
  }
}

let stub: Stub;

beforeEach(async () => {
  await redis.del(GATE_KEY);
  stub = await startStub('epoch-one');
});

afterAll(async () => {
  await redis.del(GATE_KEY);
  await redis.quit();
  await prisma.$disconnect();
});

describe('warmPois', () => {
  it('warms every published listing and closes the gate', async () => {
    await seedListings(['a-one', 'a-two']);
    const { warmPois } = await loadWarmPois(stub.url);

    const result = await warmPois();

    expect(result.requested).toBe(2);
    expect(result.warmed).toBe(2);
    expect(result.failed).toBe(0);
    expect(stub.requested).toEqual(['a-one', 'a-two']);
    await expect(redis.get(GATE_KEY)).resolves.toBe('epoch-one');

    stub.server.close();
  });

  it('is a no-op once the gate holds the current epoch', async () => {
    await seedListings(['b-one']);
    await redis.set(GATE_KEY, 'epoch-one');
    const { warmPois } = await loadWarmPois(stub.url);

    const result = await warmPois();

    expect(result.skipped).toBe('already-warmed');
    expect(stub.requested).toEqual([]);

    stub.server.close();
  });

  it('runs again when the epoch has moved', async () => {
    await seedListings(['c-one']);
    await redis.set(GATE_KEY, 'an-older-epoch');
    const { warmPois } = await loadWarmPois(stub.url);

    const result = await warmPois();

    expect(result.warmed).toBe(1);
    await expect(redis.get(GATE_KEY)).resolves.toBe('epoch-one');

    stub.server.close();
  });

  /**
   * The one that matters. A partial warm that closed the gate would leave the
   * listings it missed cold until the next rebuild, so the gate must stay open.
   */
  it('leaves the gate open when a listing failed', async () => {
    await seedListings(['d-one', 'd-two']);
    stub.failFor.add('d-two');
    const { warmPois } = await loadWarmPois(stub.url);

    const result = await warmPois();

    expect(result.warmed).toBe(1);
    expect(result.failed).toBe(1);
    await expect(redis.get(GATE_KEY)).resolves.toBeNull();

    stub.server.close();
  });

  it('names itself so machine traffic is distinguishable from a visitor', async () => {
    await seedListings(['g-one']);
    const { warmPois, warmHeaders } = await loadWarmPois(stub.url);

    await warmPois();

    expect(stub.agents).toHaveLength(1);
    expect(stub.agents[0]).toBe(warmHeaders()['user-agent']);
    expect(stub.agents[0]).toContain('MachiyaBot');

    stub.server.close();
  });

  /**
   * The limiter exemption rides on the secret, never on the User-Agent — a
   * name any caller can forge would make the rate limit optional.
   */
  it('sends the internal token only when one is configured', async () => {
    await seedListings(['i-one']);

    delete process.env.INTERNAL_REQUEST_TOKEN;
    const withoutToken = await loadWarmPois(stub.url);
    await withoutToken.warmPois();
    expect(stub.tokens).toEqual([undefined]);
    expect(withoutToken.warmHeaders()['x-internal-token']).toBeUndefined();

    await redis.del(GATE_KEY);
    process.env.INTERNAL_REQUEST_TOKEN = 'y'.repeat(32);
    const withToken = await loadWarmPois(stub.url);
    await withToken.warmPois();
    expect(stub.tokens.at(-1)).toBe('y'.repeat(32));

    delete process.env.INTERNAL_REQUEST_TOKEN;
    stub.server.close();
  });

  /**
   * A 429 is not the listing's fault, and every request after it in the same
   * pass would fail for the same reason. Stop, leave the gate open, continue on
   * the next tick.
   */
  it('stops the pass and leaves the gate open when rate-limited', async () => {
    await seedListings(['h-one', 'h-two', 'h-three']);
    stub.limitFor.add('h-two');
    const { warmPois } = await loadWarmPois(stub.url);

    const result = await warmPois();

    expect(result.warmed).toBe(1);
    expect(result.rateLimited).toBe(true);
    expect(stub.requested).toEqual(['h-one', 'h-two']);
    await expect(redis.get(GATE_KEY)).resolves.toBeNull();

    stub.server.close();
  });

  it('does nothing against an unbuilt geo epoch', async () => {
    await seedListings(['e-one']);
    stub.epoch = GEO_EPOCH_UNBUILT;
    const { warmPois } = await loadWarmPois(stub.url);

    const result = await warmPois();

    expect(result.skipped).toBe('artifacts-unbuilt');
    expect(stub.requested).toEqual([]);
    await expect(redis.get(GATE_KEY)).resolves.toBeNull();

    stub.server.close();
  });

  it('skips quietly when the API is unreachable', async () => {
    await seedListings(['f-one']);
    const unreachable = stub.url;
    stub.server.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const { warmPois } = await loadWarmPois(unreachable);
    const result = await warmPois();

    expect(result.skipped).toBe('unreachable');
    expect(result.requested).toBe(0);
  });
});
