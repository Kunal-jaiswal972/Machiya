import { prisma } from '@machiya/db';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Object storage is mocked: these tests are about ownership, validation and
// status transitions, none of which involve bytes. The pipeline gets its own
// suite with real image data.
// Object storage and the queue are mocked: these tests are about ownership,
// validation and status transitions, none of which involve bytes. Derivation
// has its own suite in packages/shared, against real sharp.
vi.mock('../src/lib/storage.js', () => ({
  UPLOAD_URL_TTL_SECONDS: 900,
  createUploadTicket: vi.fn(async () => ({
    uploadUrl: 'http://localhost:9000/machiya-listings',
    fields: { key: 'originals/x', 'Content-Type': 'image/jpeg' },
    requiredHeaders: {},
  })),
  headObject: vi.fn(async () => ({ exists: true, byteSize: 2048 })),
  deleteObject: vi.fn(async () => undefined),
  deleteObjects: vi.fn(async () => undefined),
  publicVariantUrl: (key: string) => `http://localhost:9000/machiya-listings/${key}`,
  s3: {},
  BUCKET: 'machiya-listings',
}));

vi.mock('../src/lib/queues.js', () => ({
  QUEUE_NAMES: { images: 'images', fuelPrices: 'fuel-prices' },
  enqueueImageProcessing: vi.fn(async () => undefined),
  closeQueues: vi.fn(async () => undefined),
}));

const { changeStatus, createDraft, deleteListing, getListingBySlug, listOwned, patchListing } =
  await import('../src/services/listings.js');
const { requestImageUpload, markImageUploaded, reorderImages, deleteImage } =
  await import('../src/services/listing-images.js');
const { headObject } = await import('../src/lib/storage.js');
const { enqueueImageProcessing } = await import('../src/lib/queues.js');
const { resetWorld, draftBody } = await import('./listing-fixtures.js');

type World = Awaited<ReturnType<typeof resetWorld>>;

let world: World;

beforeEach(async () => {
  world = await resetWorld();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** A draft plus one READY image, which is what publishing requires. */
async function draftWithPhoto(overrides: Record<string, unknown> = {}) {
  const listing = await createDraft(world.ownerSession, draftBody(overrides));
  const ticket = await requestImageUpload(world.ownerSession, listing.id, {
    contentType: 'image/jpeg',
    byteSize: 2048,
  });
  // Stands in for the worker having derived it.
  await prisma.listingImage.update({
    where: { id: ticket.imageId },
    data: { status: 'READY', width: 1200, height: 800 },
  });
  return listing;
}

describe('createDraft', () => {
  it('creates a DRAFT owned by the session user, ignoring any ownerId sent', async () => {
    const listing = await createDraft(
      world.ownerSession,
      draftBody({ ownerId: world.strangerSession.userId, status: 'PUBLISHED', isVerified: true }),
    );

    const row = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });

    expect(row.ownerId).toBe(world.ownerSession.userId);
    expect(row.status).toBe('DRAFT');
    expect(row.isVerified).toBe(false);
    expect(row.publishedAt).toBeNull();
  });

  it('builds a slug from the city and title, unique across identical titles', async () => {
    const first = await createDraft(world.ownerSession, draftBody());
    const second = await createDraft(world.ownerSession, draftBody());

    expect(first.slug).toMatch(/^patna-bright-2bhk-near-boring-road-/);
    expect(second.slug).not.toBe(first.slug);
  });

  it('attaches the amenities it was given', async () => {
    const listing = await createDraft(world.ownerSession, draftBody());
    const joins = await prisma.listingAmenity.findMany({
      where: { listingId: listing.id },
      include: { amenity: true },
    });

    expect(joins.map((join) => join.amenity.slug).sort()).toEqual(['lift', 'parking']);
  });

  it('rejects an unknown city and an unknown amenity', async () => {
    await expect(
      createDraft(world.ownerSession, draftBody({ citySlug: 'atlantis' })),
    ).rejects.toMatchObject({ status: 400, code: 'unknown_city' });

    await expect(
      createDraft(world.ownerSession, draftBody({ amenitySlugs: ['helipad'] })),
    ).rejects.toMatchObject({ status: 400, code: 'unknown_amenity' });
  });

  it('rejects a body that fails validation', async () => {
    await expect(createDraft(world.ownerSession, draftBody({ title: 'short' }))).rejects.toThrow();

    await expect(createDraft(world.ownerSession, draftBody({ lat: 91 }))).rejects.toThrow();
  });
});

describe('ownership', () => {
  it('lets the owner patch and blocks a stranger', async () => {
    const listing = await createDraft(world.ownerSession, draftBody());

    await patchListing(world.ownerSession, listing.id, { bedrooms: 3 });
    const patched = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(patched.bedrooms).toBe(3);

    await expect(
      patchListing(world.strangerSession, listing.id, { bedrooms: 9 }),
    ).rejects.toMatchObject({ status: 403, code: 'forbidden_owner' });

    const untouched = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(untouched.bedrooms).toBe(3);
  });

  it('lets an admin patch someone else’s listing', async () => {
    const listing = await createDraft(world.ownerSession, draftBody());

    await patchListing(world.adminSession, listing.id, { bedrooms: 4 });

    const row = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(row.bedrooms).toBe(4);
  });

  it('blocks a stranger from deleting, publishing or touching images', async () => {
    const listing = await draftWithPhoto();

    await expect(deleteListing(world.strangerSession, listing.id)).rejects.toMatchObject({
      status: 403,
    });
    await expect(changeStatus(world.strangerSession, listing.id, 'publish')).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      requestImageUpload(world.strangerSession, listing.id, {
        contentType: 'image/jpeg',
        byteSize: 1024,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('404s rather than 403s for a listing that does not exist', async () => {
    await expect(patchListing(world.ownerSession, 'nope', { bedrooms: 2 })).rejects.toMatchObject({
      status: 404,
      code: 'listing_not_found',
    });
  });
});

describe('publishing', () => {
  it('upgrades a seeker to lister on their first publish', async () => {
    const listing = await draftWithPhoto();

    const result = await changeStatus(world.ownerSession, listing.id, 'publish');

    expect(result.status).toBe('PUBLISHED');
    expect(result.roleUpgraded).toBe(true);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: world.ownerSession.userId } });
    expect(user.role).toBe('LISTER');
  });

  it('does not re-upgrade a user who is already a lister', async () => {
    const listing = await createDraft(world.strangerSession, draftBody());
    await prisma.listingImage.create({
      data: {
        listingId: listing.id,
        objectKey: null,
        status: 'READY',
        width: 800,
        height: 600,
        isCover: true,
      },
    });

    const result = await changeStatus(world.strangerSession, listing.id, 'publish');

    expect(result.roleUpgraded).toBe(false);
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: world.strangerSession.userId },
    });
    expect(user.role).toBe('LISTER');
  });

  it('refuses to publish a rental with no rent', async () => {
    const listing = await draftWithPhoto({ rentAmount: null });

    await expect(changeStatus(world.ownerSession, listing.id, 'publish')).rejects.toMatchObject({
      status: 422,
      code: 'listing_incomplete',
    });

    const row = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(row.status).toBe('DRAFT');
  });

  it('refuses to publish a sale with no price', async () => {
    const listing = await draftWithPhoto({
      listingType: 'SALE',
      rentAmount: null,
      salePrice: null,
    });

    await expect(changeStatus(world.ownerSession, listing.id, 'publish')).rejects.toMatchObject({
      status: 422,
    });
  });

  it('refuses to publish a flat above the top of its building', async () => {
    const listing = await draftWithPhoto({ floor: 12, totalFloors: 8 });

    await expect(changeStatus(world.ownerSession, listing.id, 'publish')).rejects.toMatchObject({
      status: 422,
    });
  });

  it('refuses to publish without a photo, and leaves the role alone', async () => {
    const listing = await createDraft(world.ownerSession, draftBody());

    await expect(changeStatus(world.ownerSession, listing.id, 'publish')).rejects.toMatchObject({
      status: 422,
      code: 'listing_needs_photo',
    });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: world.ownerSession.userId } });
    expect(user.role).toBe('SEEKER');
  });

  it('keeps the original publishedAt when re-published after a pause', async () => {
    const listing = await draftWithPhoto();
    await changeStatus(world.ownerSession, listing.id, 'publish');
    const first = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });

    await changeStatus(world.ownerSession, listing.id, 'pause');
    await changeStatus(world.ownerSession, listing.id, 'unpause');

    const again = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(again.status).toBe('PUBLISHED');
    expect(again.publishedAt?.toISOString()).toBe(first.publishedAt?.toISOString());
  });

  it('rejects unpausing a listing that is not paused', async () => {
    const listing = await draftWithPhoto();
    await changeStatus(world.ownerSession, listing.id, 'publish');

    await expect(changeStatus(world.ownerSession, listing.id, 'unpause')).rejects.toMatchObject({
      status: 409,
      code: 'not_paused',
    });
  });

  it('marks a listing rented', async () => {
    const listing = await draftWithPhoto();
    await changeStatus(world.ownerSession, listing.id, 'publish');

    const result = await changeStatus(world.ownerSession, listing.id, 'mark-rented');
    expect(result.status).toBe('RENTED');
  });
});

describe('visibility', () => {
  it('hides a draft from everyone but its owner and an admin', async () => {
    const listing = await createDraft(world.ownerSession, draftBody());
    const { slug } = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });

    await expect(getListingBySlug(slug)).rejects.toMatchObject({
      status: 404,
      code: 'listing_not_found',
    });
    await expect(getListingBySlug(slug, world.strangerSession)).rejects.toMatchObject({
      status: 404,
    });

    await expect(getListingBySlug(slug, world.ownerSession)).resolves.toMatchObject({
      viewerIsOwner: true,
    });
    await expect(getListingBySlug(slug, world.adminSession)).resolves.toMatchObject({
      viewerIsOwner: true,
    });
  });

  it('shows a published listing to an anonymous reader', async () => {
    const listing = await draftWithPhoto();
    await changeStatus(world.ownerSession, listing.id, 'publish');
    const { slug } = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });

    const result = await getListingBySlug(slug);
    expect(result.viewerIsOwner).toBe(false);
    expect(result.listing.images).toHaveLength(1);
  });
});

describe('listOwned', () => {
  it('returns only the caller’s listings, whatever ownerId they ask for', async () => {
    await createDraft(world.ownerSession, draftBody());
    await createDraft(world.strangerSession, draftBody({ title: 'Stranger flat in Kankarbagh' }));

    const mine = await listOwned(world.ownerSession, {
      limit: 20,
      ownerId: world.strangerSession.userId,
    });

    expect(mine.listings).toHaveLength(1);
    expect(mine.listings[0]?.title).toBe('Bright 2BHK near Boring Road');
  });

  it('lets an admin read another user’s listings', async () => {
    await createDraft(world.ownerSession, draftBody());

    const theirs = await listOwned(world.adminSession, {
      limit: 20,
      ownerId: world.ownerSession.userId,
    });

    expect(theirs.listings).toHaveLength(1);
  });

  it('pages with a cursor', async () => {
    for (let n = 0; n < 3; n += 1) {
      await createDraft(world.ownerSession, draftBody({ title: `Flat number ${n} in Patna` }));
    }

    const first = await listOwned(world.ownerSession, { limit: 2 });
    expect(first.listings).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await listOwned(world.ownerSession, {
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.listings).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });
});

describe('images', () => {
  it('makes the first image the cover and orders the rest', async () => {
    const listing = await createDraft(world.ownerSession, draftBody());

    const first = await requestImageUpload(world.ownerSession, listing.id, {
      contentType: 'image/jpeg',
      byteSize: 1024,
    });
    const second = await requestImageUpload(world.ownerSession, listing.id, {
      contentType: 'image/png',
      byteSize: 1024,
    });

    const rows = await prisma.listingImage.findMany({
      where: { listingId: listing.id },
      orderBy: { sortOrder: 'asc' },
    });

    expect(rows.map((row) => row.id)).toEqual([first.imageId, second.imageId]);
    expect(rows.map((row) => row.isCover)).toEqual([true, false]);
    // Uploads land in the PRIVATE originals prefix; the extension follows the
    // declared type, but the bytes are not trusted until the worker decodes them.
    expect(first.objectKey).toMatch(/^originals\//);
    expect(first.objectKey).toMatch(/\.jpg$/);
    expect(second.objectKey).toMatch(/\.png$/);
  });

  it('reorders and moves the cover with the new first position', async () => {
    const listing = await createDraft(world.ownerSession, draftBody());
    const a = await requestImageUpload(world.ownerSession, listing.id, {
      contentType: 'image/jpeg',
      byteSize: 1024,
    });
    const b = await requestImageUpload(world.ownerSession, listing.id, {
      contentType: 'image/jpeg',
      byteSize: 1024,
    });

    const reordered = await reorderImages(world.ownerSession, listing.id, {
      imageIds: [b.imageId, a.imageId],
    });

    expect(reordered.map((image) => image.id)).toEqual([b.imageId, a.imageId]);
    expect(reordered.map((image) => image.isCover)).toEqual([true, false]);
  });

  it('refuses a reorder that names an image from another listing', async () => {
    const mine = await createDraft(world.ownerSession, draftBody());
    const theirs = await createDraft(
      world.strangerSession,
      draftBody({ title: 'Their flat here' }),
    );

    const myImage = await requestImageUpload(world.ownerSession, mine.id, {
      contentType: 'image/jpeg',
      byteSize: 1024,
    });
    const theirImage = await requestImageUpload(world.strangerSession, theirs.id, {
      contentType: 'image/jpeg',
      byteSize: 1024,
    });

    await expect(
      reorderImages(world.ownerSession, mine.id, {
        imageIds: [myImage.imageId, theirImage.imageId],
      }),
    ).rejects.toMatchObject({ status: 400, code: 'image_not_found' });
  });

  it('refuses a partial reorder', async () => {
    const listing = await createDraft(world.ownerSession, draftBody());
    const a = await requestImageUpload(world.ownerSession, listing.id, {
      contentType: 'image/jpeg',
      byteSize: 1024,
    });
    await requestImageUpload(world.ownerSession, listing.id, {
      contentType: 'image/jpeg',
      byteSize: 1024,
    });

    await expect(
      reorderImages(world.ownerSession, listing.id, { imageIds: [a.imageId] }),
    ).rejects.toMatchObject({ status: 400, code: 'incomplete_order' });
  });

  it('promotes a new cover when the cover is deleted', async () => {
    const listing = await createDraft(world.ownerSession, draftBody());
    const cover = await requestImageUpload(world.ownerSession, listing.id, {
      contentType: 'image/jpeg',
      byteSize: 1024,
    });
    const other = await requestImageUpload(world.ownerSession, listing.id, {
      contentType: 'image/jpeg',
      byteSize: 1024,
    });

    await deleteImage(world.ownerSession, listing.id, cover.imageId);

    const rows = await prisma.listingImage.findMany({ where: { listingId: listing.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(other.imageId);
    expect(rows[0]?.isCover).toBe(true);
    expect(rows[0]?.sortOrder).toBe(0);
  });

  it('refuses to delete an image belonging to another listing', async () => {
    const mine = await createDraft(world.ownerSession, draftBody());
    const theirs = await createDraft(
      world.strangerSession,
      draftBody({ title: 'Their flat here' }),
    );
    const theirImage = await requestImageUpload(world.strangerSession, theirs.id, {
      contentType: 'image/jpeg',
      byteSize: 1024,
    });

    await expect(
      deleteImage(world.ownerSession, mine.id, theirImage.imageId),
    ).rejects.toMatchObject({ status: 404, code: 'image_not_found' });
  });

  it('serves no urls until the worker marks an image READY', async () => {
    const listing = await createDraft(world.ownerSession, draftBody());
    const ticket = await requestImageUpload(world.ownerSession, listing.id, {
      contentType: 'image/jpeg',
      byteSize: 1024,
    });
    const { slug } = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });

    const before = await getListingBySlug(slug, world.ownerSession);
    expect(before.listing.images[0]?.status).toBe('PENDING');
    // The original is private, so there is nothing public to point at yet.
    expect(before.listing.images[0]?.urls).toBeNull();

    await prisma.listingImage.update({
      where: { id: ticket.imageId },
      data: { status: 'READY', width: 1200, height: 800 },
    });

    const after = await getListingBySlug(slug, world.ownerSession);
    expect(after.listing.images[0]?.urls?.card).toContain('variants/');
  });
});

describe('deleteListing', () => {
  it('removes the listing and everything hanging off it', async () => {
    const listing = await draftWithPhoto();

    await deleteListing(world.ownerSession, listing.id);

    expect(await prisma.listing.count({ where: { id: listing.id } })).toBe(0);
    expect(await prisma.listingImage.count({ where: { listingId: listing.id } })).toBe(0);
    expect(await prisma.listingAmenity.count({ where: { listingId: listing.id } })).toBe(0);
  });
});

describe('markImageUploaded', () => {
  it('confirms the object exists, queues derivation, and reads no bytes', async () => {
    const listing = await createDraft(world.ownerSession, draftBody());
    const ticket = await requestImageUpload(world.ownerSession, listing.id, {
      contentType: 'image/jpeg',
      byteSize: 2048,
    });

    const image = await markImageUploaded(world.ownerSession, listing.id, ticket.imageId);

    expect(image.status).toBe('PENDING');
    expect(headObject).toHaveBeenCalledWith(ticket.objectKey);
    expect(enqueueImageProcessing).toHaveBeenCalledWith({
      listingId: listing.id,
      imageId: ticket.imageId,
      objectKey: ticket.objectKey,
    });
  });

  it('refuses when the upload never arrived, rather than queueing a doomed job', async () => {
    const listing = await createDraft(world.ownerSession, draftBody());
    const ticket = await requestImageUpload(world.ownerSession, listing.id, {
      contentType: 'image/jpeg',
      byteSize: 2048,
    });

    vi.mocked(headObject).mockResolvedValueOnce({ exists: false });

    await expect(
      markImageUploaded(world.ownerSession, listing.id, ticket.imageId),
    ).rejects.toMatchObject({ status: 409, code: 'upload_missing' });
  });

  it('is a no-op for an image that is already READY', async () => {
    const listing = await draftWithPhoto();
    const existing = await prisma.listingImage.findFirstOrThrow({
      where: { listingId: listing.id },
    });

    vi.mocked(enqueueImageProcessing).mockClear();
    const image = await markImageUploaded(world.ownerSession, listing.id, existing.id);

    expect(image.status).toBe('READY');
    expect(enqueueImageProcessing).not.toHaveBeenCalled();
  });

  it('blocks a stranger', async () => {
    const listing = await createDraft(world.ownerSession, draftBody());
    const ticket = await requestImageUpload(world.ownerSession, listing.id, {
      contentType: 'image/jpeg',
      byteSize: 2048,
    });

    await expect(
      markImageUploaded(world.strangerSession, listing.id, ticket.imageId),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('publish gate and image status', () => {
  it('refuses to publish while photos are still processing, and says so', async () => {
    const listing = await createDraft(world.ownerSession, draftBody());
    await requestImageUpload(world.ownerSession, listing.id, {
      contentType: 'image/jpeg',
      byteSize: 2048,
    });

    await expect(changeStatus(world.ownerSession, listing.id, 'publish')).rejects.toMatchObject({
      status: 422,
      code: 'listing_needs_photo',
      message: expect.stringContaining('still being processed'),
    });
  });

  it('refuses to publish on a REJECTED photo', async () => {
    const listing = await createDraft(world.ownerSession, draftBody());
    const ticket = await requestImageUpload(world.ownerSession, listing.id, {
      contentType: 'image/jpeg',
      byteSize: 2048,
    });

    await prisma.listingImage.update({
      where: { id: ticket.imageId },
      data: { status: 'REJECTED', failureReason: 'That file is not a recognisable image' },
    });

    await expect(changeStatus(world.ownerSession, listing.id, 'publish')).rejects.toMatchObject({
      status: 422,
      code: 'listing_needs_photo',
    });
  });

  it('surfaces the rejection reason to the owner', async () => {
    const listing = await createDraft(world.ownerSession, draftBody());
    const ticket = await requestImageUpload(world.ownerSession, listing.id, {
      contentType: 'image/jpeg',
      byteSize: 2048,
    });
    await prisma.listingImage.update({
      where: { id: ticket.imageId },
      data: { status: 'REJECTED', failureReason: 'Animated images are not supported' },
    });

    const { slug } = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    const detail = await getListingBySlug(slug, world.ownerSession);

    expect(detail.listing.images[0]?.status).toBe('REJECTED');
    expect(detail.listing.images[0]?.failureReason).toContain('Animated');
  });
});
