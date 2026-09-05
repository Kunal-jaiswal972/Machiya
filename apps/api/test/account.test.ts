import { prisma } from '@machiya/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { deleteAccount, updateProfile } from '../src/services/account.js';
import { createEnquiry } from '../src/services/enquiries.js';
import { resetWorld } from './listing-fixtures.js';

type World = Awaited<ReturnType<typeof resetWorld>>;

let world: World;
let listingId: string;
let listingSlug: string;

beforeEach(async () => {
  world = await resetWorld();

  const listing = await prisma.listing.create({
    data: {
      slug: 'patna-a-flat-to-leave-behind-aaa222',
      ownerId: world.ownerSession.userId,
      cityId: world.cityId,
      title: 'A flat to leave behind',
      description: 'The listing a departing owner leaves behind them.',
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

  listingId = listing.id;
  listingSlug = listing.slug;
});

describe('updateProfile', () => {
  it('normalises a phone number however it was typed', async () => {
    for (const typed of ['9876543210', '+91 98765 43210', '98765-43210']) {
      const { user } = await updateProfile(world.ownerSession, { phone: typed });
      expect(user.phone, `"${typed}" did not normalise`).toBe('+919876543210');
    }
  });

  it('refuses a number that is not one', async () => {
    await expect(updateProfile(world.ownerSession, { phone: '12345' })).rejects.toThrow();
  });

  it('un-verifies a number when it changes', async () => {
    await updateProfile(world.ownerSession, { phone: '9876543210' });
    await prisma.user.update({
      where: { id: world.ownerSession.userId },
      data: { isPhoneVerified: true },
    });

    await updateProfile(world.ownerSession, { phone: '9876543211' });

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: world.ownerSession.userId },
    });
    expect(after.isPhoneVerified).toBe(false);
  });

  it('leaves out what the patch does not mention', async () => {
    await updateProfile(world.ownerSession, { name: 'Renamed', phone: '9876543210' });
    await updateProfile(world.ownerSession, { name: 'Renamed twice' });

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: world.ownerSession.userId },
    });
    expect(after.name).toBe('Renamed twice');
    expect(after.phone).toBe('+919876543210');
  });
});

describe('deleteAccount', () => {
  it('scrubs the person and keeps the counterpart their conversation', async () => {
    const enquiry = await createEnquiry(world.strangerSession, listingSlug, {
      body: 'Is this still available? I would like to see it this weekend.',
    });

    await prisma.officeLocation.create({
      data: {
        userId: world.ownerSession.userId,
        label: 'Work',
        address: 'Boring Road, Patna',
        lat: 25.6127,
        lng: 85.1145,
        isDefault: true,
      },
    });

    await deleteAccount(world.ownerSession);

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: world.ownerSession.userId },
    });

    expect(user.deletedAt).not.toBeNull();
    expect(user.name).toBe('Deleted account');
    expect(user.email).toBe(`deleted-${world.ownerSession.userId}@machiya.invalid`);
    expect(user.phone).toBeNull();
    expect(user.banned).toBe(true);

    // The seeker is still party to this thread and still has their copy of it.
    const thread = await prisma.enquiry.findUnique({
      where: { id: enquiry.enquiryId },
      include: { messages: true },
    });
    expect(thread?.messages.length).toBeGreaterThan(0);

    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
    expect(listing.status).toBe('PAUSED');

    expect(
      await prisma.officeLocation.count({ where: { userId: world.ownerSession.userId } }),
    ).toBe(0);
    expect(await prisma.session.count({ where: { userId: world.ownerSession.userId } })).toBe(0);
    expect(await prisma.account.count({ where: { userId: world.ownerSession.userId } })).toBe(0);
  });
});
