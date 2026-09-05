import { prisma } from '@machiya/db';
import { commutePreferencesToQuery, DEFAULT_COMMUTE_PREFERENCES } from '@machiya/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { resetWorld } from './listing-fixtures.js';

/**
 * The commute answer must be a function of the request.
 *
 * `docs/ux-audit.md` 1.1: this endpoint carried `cache-control: private,
 * max-age=120` while its answer varied by the caller's STORED preferences,
 * which appear in no URL and no `Vary` header. The browser served its own copy
 * for two minutes, so changing mileage left every figure on screen unmoved
 * until the cache expired — which is why it "sometimes worked". The controls
 * behind the product's entire argument did nothing.
 *
 * These tests pin the two halves of the fix: the settings travel in the URL,
 * and the response is only cacheable when they do.
 */
describe('commutePreferencesToQuery', () => {
  it('emits every field the answer depends on', () => {
    const query = commutePreferencesToQuery(DEFAULT_COMMUTE_PREFERENCES);

    expect(query).toMatchObject({
      mode: 'car',
      vehicleClass: 'hatchback',
      fuelType: 'PETROL',
      tripsPerDay: '2',
      workingDaysPerMonth: '22',
    });
  });

  it('omits a null mileage rather than sending the string "null"', () => {
    // Null means "use the vehicle class default" and is not the same as a
    // number that happens to equal it (D63). Serialised naively it becomes
    // "null", which the coercing schema would then reject.
    expect(commutePreferencesToQuery(DEFAULT_COMMUTE_PREFERENCES)).not.toHaveProperty(
      'mileageKmPerLitre',
    );

    expect(
      commutePreferencesToQuery({ ...DEFAULT_COMMUTE_PREFERENCES, mileageKmPerLitre: 42 }),
    ).toMatchObject({ mileageKmPerLitre: '42' });
  });

  it('is stable, so two clients with the same settings produce the same URL', () => {
    // A URL that varies on noise is a cache keyed on noise.
    const a = commutePreferencesToQuery({ ...DEFAULT_COMMUTE_PREFERENCES, tripsPerDay: 4 });
    const b = commutePreferencesToQuery({ ...DEFAULT_COMMUTE_PREFERENCES, tripsPerDay: 4 });

    expect(new URLSearchParams(a).toString()).toBe(new URLSearchParams(b).toString());
  });
});

describe('the commute endpoint', () => {
  const OFFICE = { lat: 25.6127, lng: 85.1145 };
  let slug: string;
  let server: Awaited<ReturnType<typeof buildApp>>;

  async function buildApp() {
    const { createApp } = await import('../src/app.js');
    return createApp({
      mountAuth: false,
      requestLogging: false,
      // Anonymous: the settings must work with no session at all, which is the
      // other half of what was broken (audit 1.2).
      sessionResolver: async () => null,
    });
  }

  beforeAll(async () => {
    const world = await resetWorld();

    // Seeded here rather than found: the first version of this file looked for
    // an existing published listing and returned early when there was none, so
    // in a fresh test database all three endpoint tests passed by doing
    // nothing. A test that cannot fail is worse than no test (D66).
    const listing = await prisma.listing.create({
      data: {
        slug: 'patna-commute-params-aaa111',
        ownerId: world.ownerSession.userId,
        cityId: world.cityId,
        title: 'A flat to price a commute from',
        description: 'Exists so the commute endpoint has something to measure.',
        listingType: 'RENT',
        propertyType: 'APARTMENT',
        furnishing: 'UNFURNISHED',
        status: 'PUBLISHED',
        publishedAt: new Date(),
        address: 'Boring Road, Patna',
        locality: 'Boring Road',
        lat: 25.6181,
        lng: 85.1588,
        bedrooms: 2,
        bathrooms: 1,
        areaSqft: 900,
        rentAmount: 15_000,
      },
    });

    slug = listing.slug;

    // A fuel price, or the engine has nothing to spend and returns no cost.
    await prisma.fuelPrice.create({
      data: {
        cityId: world.cityId,
        fuelType: 'PETROL',
        price: 113.37,
        source: 'test',
        sourceUrl: 'https://example.test/petrol',
        fetchedAt: new Date(),
      },
    });

    server = await buildApp();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('refuses to cache an answer the URL does not describe', async () => {
    const ambient = await request(server)
      .get(`/api/listings/${slug}/commute`)
      .query({ fromLat: OFFICE.lat, fromLng: OFFICE.lng });

    expect(ambient.status).toBe(200);
    // No settings in the URL, so the answer depends on the session and must not
    // be stored by anything keyed on the URL.
    expect(ambient.headers['cache-control']).toBe('private, no-store');

    const explicit = await request(server)
      .get(`/api/listings/${slug}/commute`)
      .query({
        fromLat: OFFICE.lat,
        fromLng: OFFICE.lng,
        ...commutePreferencesToQuery(DEFAULT_COMMUTE_PREFERENCES),
      });

    expect(explicit.status).toBe(200);
    // Now the URL determines the answer, so caching it is honest again.
    expect(explicit.headers['cache-control']).toBe('private, max-age=120');
  });

  it('prices the journey from the settings in the URL', async () => {
    const ask = (mileage: number) =>
      request(server)
        .get(`/api/listings/${slug}/commute`)
        .query({
          fromLat: OFFICE.lat,
          fromLng: OFFICE.lng,
          ...commutePreferencesToQuery({
            ...DEFAULT_COMMUTE_PREFERENCES,
            mileageKmPerLitre: mileage,
          }),
        });

    const thirsty = await ask(10);
    const frugal = await ask(40);

    expect(thirsty.status).toBe(200);
    expect(frugal.status).toBe(200);
    expect(thirsty.body.selected.perMonth).toBeGreaterThan(0);

    // Four times the mileage is a quarter of the fuel. A ratio rather than a
    // figure, so a fuel-price change cannot break the test.
    const ratio = thirsty.body.selected.perMonth / frugal.body.selected.perMonth;
    expect(ratio).toBeGreaterThan(3.5);
    expect(ratio).toBeLessThan(4.5);
  });

  it('will not price a bike journey on a car', async () => {
    // The combination the UI used to produce: mode bike, vehicle sedan. It is
    // resolved rather than refused — the mode is what the person clicked, and a
    // 400 would punish an old client for something we can settle unambiguously.
    // What must never happen is a bike costed at a sedan's consumption
    // (D63, docs/ux-audit.md 1.3).
    const response = await request(server).get(`/api/listings/${slug}/commute`).query({
      fromLat: OFFICE.lat,
      fromLng: OFFICE.lng,
      mode: 'bike',
      vehicleClass: 'sedan',
    });

    expect(response.status).toBe(200);
    expect(response.body.preferences.mode).toBe('bike');
    expect(response.body.preferences.vehicleClass).toBe('scooter');

    // And the resolved settings are what it actually charged: a scooter's
    // 45 km/l, not the sedan's 13, so the figure is a bike's.
    const sameOnABike = await request(server).get(`/api/listings/${slug}/commute`).query({
      fromLat: OFFICE.lat,
      fromLng: OFFICE.lng,
      mode: 'bike',
      vehicleClass: 'scooter',
    });

    expect(response.body.selected.perMonth).toBe(sameOnABike.body.selected.perMonth);
  });
});
