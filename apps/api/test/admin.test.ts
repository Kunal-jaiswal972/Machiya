import { prisma } from '@machiya/db';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/storage.js', () => ({
  UPLOAD_URL_TTL_SECONDS: 900,
  createUploadTicket: vi.fn(),
  headObject: vi.fn(),
  deleteObject: vi.fn(async () => undefined),
  deleteObjects: vi.fn(async () => undefined),
  publicVariantUrl: (key: string) => `http://localhost:9000/machiya-listings/${key}`,
  s3: {},
  BUCKET: 'machiya-listings',
}));

const { coverageDemand, listUsers, moderationQueue, setListingVerified } =
  await import('../src/services/admin.js');
const { resetWorld } = await import('./listing-fixtures.js');

type World = Awaited<ReturnType<typeof resetWorld>>;

let world: World;

async function publish(options: {
  slug: string;
  publishedAt: Date;
  isVerified?: boolean;
}): Promise<string> {
  const listing = await prisma.listing.create({
    data: {
      slug: options.slug,
      ownerId: world.ownerSession.userId,
      cityId: world.cityId,
      title: `Flat ${options.slug}`,
      description: 'Somewhere for the moderation queue to hold.',
      listingType: 'RENT',
      propertyType: 'APARTMENT',
      furnishing: 'UNFURNISHED',
      status: 'PUBLISHED',
      publishedAt: options.publishedAt,
      address: 'Boring Road, Patna',
      locality: 'Boring Road',
      lat: 25.6127,
      lng: 85.1588,
      bedrooms: 2,
      bathrooms: 1,
      areaSqft: 900,
      rentAmount: 15_000,
      isVerified: options.isVerified ?? false,
    },
  });

  return listing.id;
}

beforeEach(async () => {
  world = await resetWorld();
  await prisma.coverageRequest.deleteMany({});
});

afterAll(async () => {
  await prisma.coverageRequest.deleteMany({});
  await prisma.$disconnect();
});

describe('the moderation queue', () => {
  it('is oldest first, and drops a listing once it is verified', async () => {
    const older = await publish({
      slug: 'patna-older-aaa111',
      publishedAt: new Date('2026-09-01T00:00:00Z'),
    });
    const newer = await publish({
      slug: 'patna-newer-bbb222',
      publishedAt: new Date('2026-09-04T00:00:00Z'),
    });

    // Oldest first is the point of a queue: newest-first leaves the oldest
    // unreviewed listing unreviewed forever.
    const queue = await moderationQueue(world.adminSession);
    expect(queue.map((listing) => listing.id)).toEqual([older, newer]);

    await setListingVerified(world.adminSession, older, true);

    const after = await moderationQueue(world.adminSession);
    expect(after.map((listing) => listing.id)).toEqual([newer]);
  });

  it('never shows a draft or a paused listing', async () => {
    await publish({ slug: 'patna-live-aaa111', publishedAt: new Date() });

    const paused = await publish({ slug: 'patna-paused-bbb222', publishedAt: new Date() });
    await prisma.listing.update({ where: { id: paused }, data: { status: 'PAUSED' } });

    const queue = await moderationQueue(world.adminSession);
    expect(queue).toHaveLength(1);
    expect(queue[0]?.slug).toBe('patna-live-aaa111');
  });

  it('refuses every non-admin, whatever the route did', async () => {
    await expect(moderationQueue(world.ownerSession)).rejects.toMatchObject({ status: 403 });
    await expect(listUsers(world.strangerSession)).rejects.toMatchObject({ status: 403 });
    await expect(coverageDemand(world.strangerSession)).rejects.toMatchObject({ status: 403 });
  });

  it('serves the verified side too, which is what makes unverify reachable', async () => {
    const id = await publish({
      slug: 'patna-toggle-aaa111',
      publishedAt: new Date(),
      isVerified: true,
    });

    // Not in the queue, because the queue is the unreviewed ones.
    expect(await moderationQueue(world.adminSession)).toHaveLength(0);

    const verified = await moderationQueue(world.adminSession, { verified: true });
    expect(verified.map((listing) => listing.id)).toEqual([id]);

    await setListingVerified(world.adminSession, id, false);

    expect(await moderationQueue(world.adminSession, { verified: true })).toHaveLength(0);
    expect(await moderationQueue(world.adminSession)).toHaveLength(1);
  });
});

describe('user management', () => {
  it('searches by name and by email, case-insensitively', async () => {
    const all = await listUsers(world.adminSession);
    expect(all.length).toBeGreaterThanOrEqual(3);

    const byEmail = await listUsers(world.adminSession, { query: 'STRANGER@' });
    expect(byEmail.map((user) => user.email)).toEqual(['stranger@test.local']);

    const byName = await listUsers(world.adminSession, { query: 'admi' });
    expect(byName.map((user) => user.email)).toEqual(['admin@test.local']);
  });

  it('carries the counts that make a row worth acting on', async () => {
    await publish({ slug: 'patna-counted-aaa111', publishedAt: new Date() });

    const users = await listUsers(world.adminSession, { query: 'owner@' });
    expect(users[0]?.listingCount).toBe(1);
  });
});

describe('coverage demand', () => {
  /**
   * The whole point of D55, and the reason the grouping is spatial rather than
   * a count of rows: two people asking about Mumbai will not have dropped pins
   * on the same building, and Thane and Colaba are 40 km apart.
   */
  it('clusters nearby requests and ranks by distinct people', async () => {
    await prisma.coverageRequest.createMany({
      data: [
        { email: 'a@x.com', lat: 19.076, lng: 72.877, placeLabel: 'Mumbai', asks: 3 },
        { email: 'b@x.com', lat: 19.218, lng: 72.978, placeLabel: 'Thane', asks: 1 },
        { email: 'c@x.com', lat: 17.385, lng: 78.487, placeLabel: 'Hyderabad', asks: 2 },
      ],
    });

    const demand = await coverageDemand(world.adminSession);

    expect(demand.clusters).toHaveLength(2);

    const [first, second] = demand.clusters;
    // Mumbai and Thane are one cluster of two people and four asks.
    expect(first?.people).toBe(2);
    expect(first?.asks).toBe(4);
    expect(first?.label).toBe('Mumbai');

    // Hyderabad, 600 km away, stays its own cluster rather than being merged.
    expect(second?.people).toBe(1);
    expect(second?.label).toBe('Hyderabad');
  });

  it('keeps a lone request rather than dropping it', async () => {
    await prisma.coverageRequest.create({
      data: { email: 'only@x.com', lat: 22.572, lng: 88.363, placeLabel: 'Kolkata' },
    });

    const demand = await coverageDemand(world.adminSession);

    // minpoints => 1: a city nobody has asked about twice yet is still a data
    // point, and DBSCAN's default would discard it as noise.
    expect(demand.clusters).toHaveLength(1);
    expect(demand.clusters[0]?.people).toBe(1);
  });
});
