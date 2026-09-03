import { prisma } from '@machiya/db';
import type { UserRole } from '@machiya/shared';
import type { RequestSession } from '../src/middleware/require-auth.js';

export interface ListingTestWorld {
  cityId: string;
  ownerSession: RequestSession;
  strangerSession: RequestSession;
  adminSession: RequestSession;
}

function sessionFor(id: string, role: UserRole, email: string): RequestSession {
  return {
    userId: id,
    role,
    user: { id, email, name: email, emailVerified: true, role, banned: false },
  };
}

/** A city, three users and nothing else. Each test builds the listings it needs. */
export async function resetWorld(): Promise<ListingTestWorld> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE "ListingAmenity", "ListingImage", "ListingView", "Favorite",
      "EnquiryMessage", "Enquiry", "SavedSearch", "FuelPrice", "Listing",
      "OfficeLocation", "Amenity", "Locality", "Session", "Account", "User", "City"
      RESTART IDENTITY CASCADE
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

  await prisma.amenity.createMany({
    data: [
      { slug: 'lift', name: 'Lift', category: 'building' },
      { slug: 'parking', name: 'Parking', category: 'building' },
    ],
  });

  const [owner, stranger, admin] = await Promise.all([
    prisma.user.create({
      data: { email: 'owner@test.local', name: 'Owner', role: 'SEEKER', emailVerified: true },
    }),
    prisma.user.create({
      data: { email: 'stranger@test.local', name: 'Stranger', role: 'LISTER', emailVerified: true },
    }),
    prisma.user.create({
      data: { email: 'admin@test.local', name: 'Admin', role: 'ADMIN', emailVerified: true },
    }),
  ]);

  return {
    cityId: city.id,
    // The owner starts as a SEEKER on purpose: publishing must upgrade them.
    ownerSession: sessionFor(owner.id, 'SEEKER', owner.email),
    strangerSession: sessionFor(stranger.id, 'LISTER', stranger.email),
    adminSession: sessionFor(admin.id, 'ADMIN', admin.email),
  };
}

/** A complete, valid draft body. Tests override single fields from this. */
export function draftBody(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Bright 2BHK near Boring Road',
    description:
      'A comfortable two bedroom flat a short walk from Boring Road, with a balcony and covered parking.',
    listingType: 'RENT',
    propertyType: 'APARTMENT',
    furnishing: 'SEMI_FURNISHED',
    citySlug: 'patna',
    address: 'Boring Road, Patna',
    locality: 'Boring Road',
    lat: 25.6127,
    lng: 85.1145,
    bedrooms: 2,
    bathrooms: 2,
    areaSqft: 950,
    floor: 3,
    totalFloors: 8,
    rentAmount: 15_000,
    securityDeposit: 30_000,
    rules: ['No smoking indoors'],
    amenitySlugs: ['lift', 'parking'],
    ...overrides,
  };
}
