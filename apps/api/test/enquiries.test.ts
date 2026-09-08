import { prisma } from '@machiya/db';
import { ENQUIRY_NOTIFY_QUIET_HOURS } from '@machiya/shared';
import { variantBaseKey } from '@machiya/shared/images';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/storage.js', () => ({
  UPLOAD_URL_TTL_SECONDS: 900,
  createUploadTicket: vi.fn(),
  headObject: vi.fn(async () => ({ exists: true, byteSize: 2048 })),
  deleteObject: vi.fn(async () => undefined),
  deleteObjects: vi.fn(async () => undefined),
  publicVariantUrl: (key: string) => `http://localhost:9000/machiya-listings/${key}`,
  s3: {},
  BUCKET: 'machiya-listings',
}));

vi.mock('../src/lib/queues.js', () => ({
  QUEUE_NAMES: { images: 'images', fuelPrices: 'fuel-prices', notifications: 'notifications' },
  enqueueImageProcessing: vi.fn(async () => undefined),
  enqueueEnquiryNotification: vi.fn(async () => undefined),
  closeQueues: vi.fn(async () => undefined),
}));

const {
  createEnquiry,
  getEnquiry,
  listEnquiries,
  markEnquiryRead,
  notificationIsOwed,
  replyToEnquiry,
  setEnquiryStatus,
} = await import('../src/services/enquiries.js');
const { getListingBySlug } = await import('../src/services/listings.js');
const { enqueueEnquiryNotification } = await import('../src/lib/queues.js');
const { resetWorld } = await import('./listing-fixtures.js');

type World = Awaited<ReturnType<typeof resetWorld>>;

let world: World;
let listingSlug: string;
let listingId: string;

beforeEach(async () => {
  vi.clearAllMocks();
  world = await resetWorld();

  const listing = await prisma.listing.create({
    data: {
      slug: 'patna-a-flat-for-enquiries-aaa111',
      ownerId: world.ownerSession.userId,
      cityId: world.cityId,
      title: 'A flat for enquiries',
      description: 'Somewhere for the enquiry tests to point at.',
      listingType: 'RENT',
      propertyType: 'APARTMENT',
      furnishing: 'SEMI_FURNISHED',
      status: 'PUBLISHED',
      publishedAt: new Date(),
      address: 'Boring Road, Patna',
      locality: 'Boring Road',
      lat: 25.6127,
      lng: 85.1588,
      bedrooms: 2,
      bathrooms: 1,
      areaSqft: 900,
      rentAmount: 15_000,
    },
  });

  listingSlug = listing.slug;
  listingId = listing.id;

  await prisma.listingImage.create({
    data: {
      id: `img-${listing.id}`,
      listingId: listing.id,
      objectKey: null,
      variantBaseKey: variantBaseKey(listing.id, `img-${listing.id}`),
      status: 'READY',
      width: 1200,
      height: 800,
      isCover: true,
    },
  });

  await prisma.user.update({
    where: { id: world.ownerSession.userId },
    data: { phone: '+919876500000' },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('the notification rule', () => {
  const now = new Date('2026-09-05T10:00:00Z');

  it('owes a mail for the first message in a thread', () => {
    expect(notificationIsOwed(null, now)).toBe(true);
  });

  it('owes nothing for a reply inside an active conversation', () => {
    const tenMinutesAgo = new Date(now.getTime() - 10 * 60_000);
    expect(notificationIsOwed(tenMinutesAgo, now)).toBe(false);
  });

  // The half of the rule the brief asked to think about: "first message" and
  // "first message in a while" are different, and people expect the second.
  it('owes a mail again once the thread has gone quiet', () => {
    const quietMs = ENQUIRY_NOTIFY_QUIET_HOURS * 3_600_000;
    expect(notificationIsOwed(new Date(now.getTime() - quietMs - 1), now)).toBe(true);
    expect(notificationIsOwed(new Date(now.getTime() - quietMs + 60_000), now)).toBe(false);
  });
});

describe('starting a thread', () => {
  it('creates one thread per seeker per listing and enqueues one mail', async () => {
    const first = await createEnquiry(world.strangerSession, listingSlug, {
      body: 'Is this still available?',
    });

    expect(enqueueEnquiryNotification).toHaveBeenCalledTimes(1);

    // A second message from the same seeker appends rather than opening a
    // second thread — the unique constraint says so and the upsert honours it.
    const second = await createEnquiry(world.strangerSession, listingSlug, {
      body: 'And is the deposit negotiable?',
    });

    expect(second.enquiryId).toBe(first.enquiryId);
    expect(await prisma.enquiry.count({ where: { listingId } })).toBe(1);

    // Still one mail: the thread is active, so the second message owes nothing.
    expect(enqueueEnquiryNotification).toHaveBeenCalledTimes(1);

    const messages = await prisma.enquiryMessage.findMany({
      where: { enquiryId: first.enquiryId },
      orderBy: { createdAt: 'asc' },
    });
    expect(messages.map((message) => message.notifyOwed)).toEqual([true, false]);
  });

  it('refuses an enquiry on your own listing', async () => {
    await expect(
      createEnquiry(world.ownerSession, listingSlug, { body: 'Hello myself' }),
    ).rejects.toMatchObject({ status: 409, code: 'own_listing' });
  });

  it('refuses an enquiry on a listing that is not published', async () => {
    await prisma.listing.update({ where: { id: listingId }, data: { status: 'PAUSED' } });

    await expect(
      createEnquiry(world.strangerSession, listingSlug, { body: 'Is this available?' }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('contact masking', () => {
  it('hides the owner phone until a thread exists, then shows it', async () => {
    const before = await getListingBySlug(listingSlug, world.strangerSession);
    expect(before.listing.owner.phone).toBeNull();
    expect(before.viewerHasEnquired).toBe(false);

    await createEnquiry(world.strangerSession, listingSlug, { body: 'Is this available?' });

    const after = await getListingBySlug(listingSlug, world.strangerSession);
    expect(after.listing.owner.phone).toBe('+919876500000');
    expect(after.viewerHasEnquired).toBe(true);
  });

  it('keeps it hidden from a signed-out reader and from a different seeker', async () => {
    await createEnquiry(world.strangerSession, listingSlug, { body: 'Is this available?' });

    const anonymous = await getListingBySlug(listingSlug);
    expect(anonymous.listing.owner.phone).toBeNull();

    const otherSeeker = await prisma.user.create({
      data: { email: 'other@test.local', name: 'Other', role: 'USER', emailVerified: true },
    });
    const otherSession = {
      userId: otherSeeker.id,
      role: 'USER' as const,
      user: {
        id: otherSeeker.id,
        email: otherSeeker.email,
        name: otherSeeker.name,
        emailVerified: true,
        role: 'USER' as const,
        banned: false,
      },
    };

    const forOther = await getListingBySlug(listingSlug, otherSession);
    expect(forOther.listing.owner.phone).toBeNull();
  });

  // Ending the conversation puts the number back behind the mask. A lister who
  // marks a thread spam has withdrawn the consent that revealed it.
  it('re-masks once the lister closes the thread', async () => {
    const { enquiryId } = await createEnquiry(world.strangerSession, listingSlug, {
      body: 'Is this available?',
    });

    await setEnquiryStatus(world.ownerSession, enquiryId, { status: 'SPAM' });

    const after = await getListingBySlug(listingSlug, world.strangerSession);
    expect(after.listing.owner.phone).toBeNull();
  });
});

describe('reading a thread', () => {
  it('is private to its two parties, and 404s rather than 403s for anyone else', async () => {
    const { enquiryId } = await createEnquiry(world.strangerSession, listingSlug, {
      body: 'Is this available?',
    });

    await expect(getEnquiry(world.ownerSession, enquiryId)).resolves.toMatchObject({
      thread: { role: 'lister' },
    });
    await expect(getEnquiry(world.strangerSession, enquiryId)).resolves.toMatchObject({
      thread: { role: 'seeker' },
    });

    const outsider = await prisma.user.create({
      data: { email: 'nosy@test.local', name: 'Nosy', role: 'USER', emailVerified: true },
    });

    await expect(
      getEnquiry(
        {
          userId: outsider.id,
          role: 'USER',
          user: {
            id: outsider.id,
            email: outsider.email,
            name: outsider.name,
            emailVerified: true,
            role: 'USER',
            banned: false,
          },
        },
        enquiryId,
      ),
      // 404, not 403: whether two other people are talking is itself private.
    ).rejects.toMatchObject({ status: 404 });
  });

  it('counts unread messages from the other party only', async () => {
    const { enquiryId } = await createEnquiry(world.strangerSession, listingSlug, {
      body: 'Is this available?',
    });

    const listerView = await listEnquiries(world.ownerSession);
    expect(listerView.unreadTotal).toBe(1);

    // The sender's own message is not unread to them.
    const seekerView = await listEnquiries(world.strangerSession);
    expect(seekerView.unreadTotal).toBe(0);

    await markEnquiryRead(world.ownerSession, enquiryId);
    expect((await listEnquiries(world.ownerSession)).unreadTotal).toBe(0);
  });

  it('moves an OPEN thread to RESPONDED when the lister replies', async () => {
    const { enquiryId } = await createEnquiry(world.strangerSession, listingSlug, {
      body: 'Is this available?',
    });

    await replyToEnquiry(world.ownerSession, enquiryId, { body: 'Yes, from next month.' });

    const thread = await prisma.enquiry.findUniqueOrThrow({ where: { id: enquiryId } });
    expect(thread.status).toBe('RESPONDED');
  });

  it('lets only the lister triage the thread', async () => {
    const { enquiryId } = await createEnquiry(world.strangerSession, listingSlug, {
      body: 'Is this available?',
    });

    await expect(
      setEnquiryStatus(world.strangerSession, enquiryId, { status: 'CLOSED' }),
    ).rejects.toMatchObject({ status: 403 });

    await expect(
      setEnquiryStatus(world.ownerSession, enquiryId, { status: 'CLOSED' }),
    ).resolves.toMatchObject({ status: 'CLOSED' });
  });
});
