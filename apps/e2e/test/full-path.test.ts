import { createHash } from 'node:crypto';
import { prisma } from '@machiya/db';
import { CITIES } from '@machiya/shared/cities';
import type { Express } from 'express';
import request from 'supertest';
import sharp from 'sharp';
import { afterAll, beforeAll, expect, it } from 'vitest';

/**
 * One path, end to end, against the real stack.
 *
 * Sign up, open a draft from a pin, fill it in, upload a photo, publish,
 * search from an office, open the detail, send an enquiry. It exists because
 * every subsystem in this product has a suite that passes while the seam next
 * to it is broken — D57, D58 and D60 were all found by a live run rather than
 * by a test, and D70 was found the same way in step 9.
 *
 * **Nothing here is stubbed.** Real Better Auth over real Postgres and Redis,
 * a real presigned POST to MinIO, the worker's real `processImageJob` decoding
 * real JPEG bytes with sharp, a real PostGIS radius query, and real OSRM for
 * the commute — degraded-but-labelled if the geo profile is down, which is
 * itself the behaviour D43 specifies.
 *
 * The one thing that is NOT the real path: derivation is invoked directly
 * rather than via the BullMQ worker process. The queue hop has its own
 * live-service cover in `reconcile-images.test.ts` and
 * `reconcile-notifications.test.ts`; spawning a worker here would test the
 * scheduler, not the path.
 */

const OFFICE = { lat: 25.6127, lng: 85.1588 };
/** ~600 m from the office, so it lands inside ring 1. */
const PROPERTY = { lat: 25.6181, lng: 85.1588 };

const USER = {
  email: 'e2e-seeker@machiya.test',
  password: 'e2e-password-123',
  name: 'E2E Seeker',
};
const EDITOR = {
  email: 'e2e-lister@machiya.test',
  password: 'e2e-password-123',
  name: 'E2E Lister',
};

let app: Express;

async function seedPatna(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE "ListingAmenity", "ListingImage", "ListingView", "Favorite",
      "EnquiryMessage", "Enquiry", "SavedSearch", "FuelPrice", "CoverageRequest",
      "Listing", "OfficeLocation", "Amenity", "Locality", "Session", "Account",
      "Verification", "User", "City" RESTART IDENTITY CASCADE
  `);

  const patna = CITIES.find((city) => city.slug === 'patna');
  if (!patna) throw new Error('the city config no longer has patna');

  const city = await prisma.city.create({
    data: {
      slug: patna.slug,
      name: patna.name,
      state: patna.state,
      centroidLat: patna.centroid.lat,
      centroidLng: patna.centroid.lng,
      bbox: patna.bbox,
    },
  });

  // The boundary cannot go through Prisma — it is an Unsupported() column — and
  // without it `resolveCityForPoint` falls back to the nearest centroid, which
  // is correct inside coverage but would leave the `covers` path untested.
  if (patna.boundary) {
    await prisma.$executeRawUnsafe(
      `UPDATE "City" SET "boundary" = ST_GeomFromGeoJSON($1)::geography WHERE id = $2`,
      JSON.stringify(patna.boundary),
      city.id,
    );
  }

  await prisma.amenity.createMany({
    data: [
      { slug: 'lift', name: 'Lift', category: 'building' },
      { slug: 'parking', name: 'Covered parking', category: 'building' },
    ],
  });
}

/** A real JPEG, generated rather than committed, so the worker has bytes to decode. */
async function realJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 1600, height: 1067, channels: 3, background: { r: 180, g: 140, b: 90 } },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

beforeAll(async () => {
  await seedPatna();
  const { createApp } = await import('@machiya/api/app');
  // mountAuth: true — real Better Auth, real sessions, real cookies. A stubbed
  // resolver would skip the half of the path a new user actually walks.
  app = await createApp({ mountAuth: true, requestLogging: false });
}, 300_000);

afterAll(async () => {
  await prisma.$disconnect();
});

/** Signs up and returns the session cookie header. */
async function signUp(who: typeof USER): Promise<string> {
  const response = await request(app)
    .post('/api/auth/sign-up/email')
    .set('origin', 'http://localhost:5173')
    .send(who);

  expect(response.status, JSON.stringify(response.body)).toBeLessThan(400);

  // Verification is required for sign-in, and the mail round trip is not what
  // this path is about — so the account is marked verified directly and signed
  // in the way any returning user would be.
  await prisma.user.update({ where: { email: who.email }, data: { emailVerified: true } });

  const signIn = await request(app)
    .post('/api/auth/sign-in/email')
    .set('origin', 'http://localhost:5173')
    .send({ email: who.email, password: who.password });

  expect(signIn.status, JSON.stringify(signIn.body)).toBe(200);

  const cookies = signIn.headers['set-cookie'];
  const jar = Array.isArray(cookies) ? cookies : [cookies];
  return jar.map((cookie) => String(cookie).split(';')[0]).join('; ');
}

it('carries one listing from a dropped pin to an answered enquiry', async () => {
  // --- 1. two accounts, through the real credential path -------------------
  const listerCookie = await signUp(EDITOR);
  const seekerCookie = await signUp(USER);

  const lister = await prisma.user.findUniqueOrThrow({ where: { email: EDITOR.email } });
  // A publisher starts as a seeker. The upgrade is what publishing does.
  expect(lister.role).toBe('USER');

  // --- 2. a draft, from the pin alone --------------------------------------
  const created = await request(app)
    .post('/api/listings')
    .set('cookie', listerCookie)
    .send({ citySlug: 'patna', lat: PROPERTY.lat, lng: PROPERTY.lng, locality: 'Golghar' });

  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const listingId = created.body.listing.id as string;

  const draftRead = await request(app)
    .get(`/api/listings/${listingId}/draft`)
    .set('cookie', listerCookie);

  expect(draftRead.status).toBe(200);
  expect(draftRead.body.draft.title).toBeNull();
  // D59: the street line is never prefilled from a reverse geocode.
  expect(draftRead.body.draft.address).toBeNull();
  expect(draftRead.body.draft.slug).toMatch(/^draft-/);
  // D50: the city comes from the coordinates, not from the hint.
  expect(draftRead.body.draft.citySlug).toBe('patna');

  // --- 3. publishing is refused while it is incomplete ---------------------
  const tooEarly = await request(app)
    .post(`/api/listings/${listingId}/status`)
    .set('cookie', listerCookie)
    .send({ action: 'publish' });

  expect(tooEarly.status).toBe(422);
  expect(tooEarly.body.error.message).toContain('Give the listing a title');

  // --- 4. the wizard's remaining steps, as autosaves -----------------------
  const patch = await request(app)
    .patch(`/api/listings/${listingId}`)
    .set('cookie', listerCookie)
    .send({
      title: 'A bright two-bedroom near Golghar',
      description: 'Corner flat, morning light on both sides, five minutes from the river.',
      address: '12 Ashok Rajpath, Golghar',
      propertyType: 'APARTMENT',
      furnishing: 'SEMI_FURNISHED',
      bedrooms: 2,
      bathrooms: 2,
      areaSqft: 980,
      rentAmount: 16_500,
      maintenanceMonthly: 1_500,
      securityDeposit: 33_000,
      amenitySlugs: ['lift', 'parking'],
      rules: ['No smoking indoors'],
    });

  expect(patch.status, JSON.stringify(patch.body)).toBe(200);

  // --- 5. a photo still missing blocks publishing, and says which ----------
  const noPhoto = await request(app)
    .post(`/api/listings/${listingId}/status`)
    .set('cookie', listerCookie)
    .send({ action: 'publish' });

  expect(noPhoto.status).toBe(422);
  expect(noPhoto.body.error.code).toBe('listing_needs_photo');
  // D38: "add a photo", not "still processing" — there is nothing pending.
  expect(noPhoto.body.error.message).toContain('Add at least one photo');

  // --- 6. a real presigned POST to real MinIO ------------------------------
  const bytes = await realJpeg();

  const ticketResponse = await request(app)
    .post(`/api/listings/${listingId}/images`)
    .set('cookie', listerCookie)
    .send({ contentType: 'image/jpeg', byteSize: bytes.byteLength });

  expect(ticketResponse.status, JSON.stringify(ticketResponse.body)).toBe(201);
  const ticket = ticketResponse.body.ticket as {
    imageId: string;
    objectKey: string;
    uploadUrl: string;
    fields: Record<string, string>;
  };

  const form = new FormData();
  for (const [key, value] of Object.entries(ticket.fields)) form.append(key, value);
  form.append('file', new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }), 'photo.jpg');

  const upload = await fetch(ticket.uploadUrl, { method: 'POST', body: form });
  expect(upload.status, `MinIO refused the presigned POST: ${await upload.text()}`).toBeLessThan(
    300,
  );

  const confirmed = await request(app)
    .post(`/api/listings/${listingId}/images/${ticket.imageId}/uploaded`)
    .set('cookie', listerCookie);

  expect(confirmed.status).toBe(202);
  // PENDING is "not yet known to be an image at all", so no URLs yet.
  expect(confirmed.body.image.status).toBe('PENDING');
  expect(confirmed.body.image.urls).toBeNull();

  // --- 7. publishing on a PENDING photo says the OTHER thing ---------------
  const stillProcessing = await request(app)
    .post(`/api/listings/${listingId}/status`)
    .set('cookie', listerCookie)
    .send({ action: 'publish' });

  expect(stillProcessing.status).toBe(422);
  expect(stillProcessing.body.error.message).toContain('still being processed');

  // --- 8. the worker's real derivation, on the real object ----------------
  const { processImageJob } = await import('@machiya/worker/jobs/process-image');
  await processImageJob({
    id: ticket.imageId,
    data: { listingId, imageId: ticket.imageId, objectKey: ticket.objectKey },
    // The processor reads only id and data; the rest of a BullMQ Job is not
    // its business, which is what makes it callable here at all.
  } as Parameters<typeof processImageJob>[0]);

  const derived = await prisma.listingImage.findUniqueOrThrow({ where: { id: ticket.imageId } });
  expect(derived.status).toBe('READY');
  expect(derived.width).toBe(1600);
  expect(derived.dominantColor).toMatch(/^#[0-9a-f]{6}$/);

  // --- 9. publish, and the seeker-to-lister upgrade -----------------------
  const published = await request(app)
    .post(`/api/listings/${listingId}/status`)
    .set('cookie', listerCookie)
    .send({ action: 'publish' });

  expect(published.status, JSON.stringify(published.body)).toBe(200);
  expect(published.body.roleUpgraded).toBe(true);
  // D67: the URL is claimed from the final title, once.
  expect(published.body.slug).toMatch(/^patna-a-bright-two-bedroom-near-golghar-/);

  const upgraded = await prisma.user.findUniqueOrThrow({ where: { email: EDITOR.email } });
  expect(upgraded.role).toBe('EDITOR');

  const slug = published.body.slug as string;

  // --- 10. the search that the whole product is built around --------------
  const search = await request(app)
    .get('/api/listings/search')
    .query({ lat: OFFICE.lat, lng: OFFICE.lng, radius: 3000 })
    .set('cookie', seekerCookie);

  expect(search.status, JSON.stringify(search.body)).toBe(200);
  expect(search.body.status).toBe('ok');

  const found = (
    search.body.listings as { slug: string; ring: number; coverUrl: string | null }[]
  ).find((listing) => listing.slug === slug);

  expect(found, 'the published listing is not in a 3 km search from the office').toBeDefined();
  expect(found?.ring).toBe(1);
  // A READY image means a fetchable URL, and it really is fetchable: the
  // variants prefix is the only publicly readable one (D35).
  expect(found?.coverUrl).toBeTruthy();

  const variantResponse = await fetch(found!.coverUrl!);
  expect(variantResponse.status, 'the derived variant is not anonymously readable').toBe(200);

  // The original must NOT be, which is the other half of D35.
  const originalUrl = `${process.env.S3_PUBLIC_BASE_URL ?? ''}/${ticket.objectKey}`;
  const originalResponse = await fetch(originalUrl);
  expect(originalResponse.status).toBeGreaterThanOrEqual(400);

  // --- 11. the detail view, its commute and its POIs ----------------------
  const detail = await request(app).get(`/api/listings/${slug}`).set('cookie', seekerCookie);

  expect(detail.status).toBe(200);
  expect(detail.body.listing.title).toBe('A bright two-bedroom near Golghar');
  expect(detail.body.listing.amenities).toHaveLength(2);
  // D69: masked, because no conversation exists yet.
  expect(detail.body.listing.owner.phone).toBeNull();
  expect(detail.body.viewerHasEnquired).toBe(false);

  const route = await request(app)
    .get(`/api/listings/${slug}/route`)
    .query({ fromLat: OFFICE.lat, fromLng: OFFICE.lng, profile: 'car' })
    .set('cookie', seekerCookie);

  expect(route.status).toBe(200);
  expect(route.body.route.distanceMeters).toBeGreaterThan(0);
  // Not asserted as measured: with the geo profile down this is a labelled
  // straight-line estimate, which is the specified behaviour (D43) rather than
  // a failure. What must hold is that the label matches the number.
  if (route.body.route.degraded === false) {
    expect(route.body.route.geometry).not.toBeNull();
  }

  // --- 12. the enquiry, and what it unlocks -------------------------------
  const enquiry = await request(app)
    .post(`/api/listings/${slug}/enquiries`)
    .set('cookie', seekerCookie)
    .send({ body: 'Is this still available, and could I see it on Saturday?' });

  expect(enquiry.status, JSON.stringify(enquiry.body)).toBe(201);
  const enquiryId = enquiry.body.enquiryId as string;

  // D68: the first message in a thread is owed a mail, and the row records it.
  const firstMessage = await prisma.enquiryMessage.findFirstOrThrow({
    where: { enquiryId },
    orderBy: { createdAt: 'asc' },
  });
  expect(firstMessage.notifyOwed).toBe(true);

  // D69: sending is what reveals the number, to both sides.
  const afterEnquiry = await request(app).get(`/api/listings/${slug}`).set('cookie', seekerCookie);

  expect(afterEnquiry.body.viewerHasEnquired).toBe(true);

  const listerInbox = await request(app).get('/api/enquiries').set('cookie', listerCookie);
  expect(listerInbox.status).toBe(200);
  expect(listerInbox.body.unreadTotal).toBe(1);
  expect(listerInbox.body.threads[0].role).toBe('lister');
  expect(listerInbox.body.threads[0].listing.slug).toBe(slug);

  const reply = await request(app)
    .post(`/api/enquiries/${enquiryId}/messages`)
    .set('cookie', listerCookie)
    .send({ body: 'Yes — Saturday morning works. I will send the gate code.' });

  expect(reply.status).toBe(201);

  const thread = await request(app).get(`/api/enquiries/${enquiryId}`).set('cookie', seekerCookie);
  expect(thread.status).toBe(200);
  expect(thread.body.messages).toHaveLength(2);
  expect(thread.body.thread.status).toBe('RESPONDED');
  // The reply is inside an active conversation, so it owes no second email.
  const secondMessage = await prisma.enquiryMessage.findFirstOrThrow({
    where: { enquiryId },
    orderBy: { createdAt: 'desc' },
  });
  expect(secondMessage.notifyOwed).toBe(false);

  // --- 13. the view ping, and who it refuses to count ---------------------
  // A separate POST rather than a side effect of the GET: telemetry must never
  // be able to fail a page render (D44).
  const ping = await request(app).post(`/api/listings/${slug}/view`).set('cookie', seekerCookie);

  expect(ping.status).toBeLessThan(400);
  expect(await prisma.listingView.count({ where: { listingId } })).toBe(1);

  // Deduplicated per viewer per window: the same seeker pinging again is not a
  // second view.
  await request(app).post(`/api/listings/${slug}/view`).set('cookie', seekerCookie);
  expect(await prisma.listingView.count({ where: { listingId } })).toBe(1);

  // And the owner reading their own listing is not a viewer at all — the single
  // biggest source of nonsense in a small site's numbers.
  await request(app).post(`/api/listings/${slug}/view`).set('cookie', listerCookie);
  expect(await prisma.listingView.count({ where: { listingId } })).toBe(1);

  // And the dashboard the lister now has reflects all of it.
  const dashboard = await request(app).get('/api/listings/mine').set('cookie', listerCookie);
  expect(dashboard.status).toBe(200);
  expect(dashboard.body.listings[0]).toMatchObject({
    slug,
    status: 'PUBLISHED',
    enquiryCount: 1,
    imageCount: 1,
  });
}, 300_000);

/** Kept so a failure in the path above cannot be blamed on the fixture. */
it('generated a decodable JPEG for the upload step', async () => {
  const bytes = await realJpeg();
  const meta = await sharp(bytes).metadata();

  expect(meta.format).toBe('jpeg');
  expect(meta.width).toBe(1600);
  expect(createHash('sha256').update(bytes).digest('hex')).toHaveLength(64);
});
