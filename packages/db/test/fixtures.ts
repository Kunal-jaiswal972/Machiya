import { prisma } from '../src/client.js';

/**
 * Flat-earth metres per degree of latitude. Deliberately approximate: PostGIS
 * measures on the WGS84 spheroid, so a fixture placed "500 m north" with this
 * constant actually measures ~497.5 m. Assertions allow for that rather than
 * pretending the two agree — see expectMeters() in the tests.
 */
const METERS_PER_DEGREE_LAT = 111_320;

export const PATNA_OFFICE = { lat: 25.5941, lng: 85.1376 } as const;
export const PUNE_OFFICE = { lat: 18.5204, lng: 73.8567 } as const;

/** A point `meters` due north of `origin`, so distances stay predictable. */
export function north(origin: { lat: number; lng: number }, meters: number) {
  return { lat: origin.lat + meters / METERS_PER_DEGREE_LAT, lng: origin.lng };
}

interface ListingFixture {
  key: string;
  meters: number;
  origin: { lat: number; lng: number };
  city: 'patna' | 'pune';
  title: string;
  address: string;
  listingType: 'RENT' | 'SALE';
  propertyType: 'APARTMENT' | 'BUILDER_FLOOR' | 'VILLA' | 'STUDIO';
  status: 'PUBLISHED' | 'DRAFT';
  furnishing: 'UNFURNISHED' | 'SEMI_FURNISHED' | 'FULLY_FURNISHED';
  bedrooms: number;
  bathrooms: number;
  areaSqft: number;
  rentAmount?: number;
  salePrice?: number;
  maintenanceMonthly?: number;
  isVerified?: boolean;
  availableFrom?: Date | null;
  amenities: string[];
}

const YESTERDAY = new Date(Date.now() - 86_400_000);
const NEXT_YEAR = new Date(Date.now() + 365 * 86_400_000);

export const LISTING_FIXTURES: ListingFixture[] = [
  {
    key: 'near_rent_2bhk',
    meters: 500,
    origin: PATNA_OFFICE,
    city: 'patna',
    title: 'Bright 2BHK near Boring Road',
    address: 'Boring Road, Patna',
    listingType: 'RENT',
    propertyType: 'APARTMENT',
    status: 'PUBLISHED',
    furnishing: 'FULLY_FURNISHED',
    bedrooms: 2,
    bathrooms: 2,
    areaSqft: 950,
    rentAmount: 15_000,
    maintenanceMonthly: 1_500,
    isVerified: true,
    availableFrom: YESTERDAY,
    amenities: ['lift', 'parking'],
  },
  {
    key: 'mid_rent_3bhk',
    meters: 1_500,
    origin: PATNA_OFFICE,
    city: 'patna',
    title: 'Spacious 3BHK builder floor',
    address: 'Rajendra Nagar, Patna',
    listingType: 'RENT',
    propertyType: 'BUILDER_FLOOR',
    status: 'PUBLISHED',
    furnishing: 'SEMI_FURNISHED',
    bedrooms: 3,
    bathrooms: 2,
    areaSqft: 1_400,
    rentAmount: 25_000,
    availableFrom: NEXT_YEAR,
    amenities: ['lift'],
  },
  {
    key: 'far_rent_villa',
    meters: 2_500,
    origin: PATNA_OFFICE,
    city: 'patna',
    title: 'Independent villa with garden',
    address: 'Hakimganj, Patna',
    listingType: 'RENT',
    propertyType: 'VILLA',
    status: 'PUBLISHED',
    furnishing: 'UNFURNISHED',
    bedrooms: 4,
    bathrooms: 4,
    areaSqft: 2_600,
    rentAmount: 60_000,
    amenities: ['parking', 'power-backup'],
  },
  {
    key: 'outside_radius',
    meters: 3_500,
    origin: PATNA_OFFICE,
    city: 'patna',
    title: 'Compact 1BHK on the bypass',
    address: 'Bypass Road, Patna',
    listingType: 'RENT',
    propertyType: 'APARTMENT',
    status: 'PUBLISHED',
    furnishing: 'UNFURNISHED',
    bedrooms: 1,
    bathrooms: 1,
    areaSqft: 480,
    rentAmount: 8_000,
    amenities: [],
  },
  {
    key: 'near_sale',
    meters: 800,
    origin: PATNA_OFFICE,
    city: 'patna',
    title: 'Resale 3BHK with river view',
    address: 'Ashok Rajpath, Patna',
    listingType: 'SALE',
    propertyType: 'APARTMENT',
    status: 'PUBLISHED',
    furnishing: 'UNFURNISHED',
    bedrooms: 3,
    bathrooms: 3,
    areaSqft: 1_600,
    salePrice: 7_500_000,
    amenities: ['lift'],
  },
  {
    key: 'draft_studio',
    meters: 600,
    origin: PATNA_OFFICE,
    city: 'patna',
    title: 'Studio being drafted',
    address: 'Kankarbagh, Patna',
    listingType: 'RENT',
    propertyType: 'STUDIO',
    status: 'DRAFT',
    furnishing: 'SEMI_FURNISHED',
    bedrooms: 1,
    bathrooms: 1,
    areaSqft: 400,
    rentAmount: 12_000,
    amenities: [],
  },
  {
    key: 'pune_rent',
    meters: 400,
    origin: PUNE_OFFICE,
    city: 'pune',
    title: 'Sunny 2BHK in Kothrud',
    address: 'Kothrud, Pune',
    listingType: 'RENT',
    propertyType: 'APARTMENT',
    status: 'PUBLISHED',
    furnishing: 'SEMI_FURNISHED',
    bedrooms: 2,
    bathrooms: 2,
    areaSqft: 900,
    rentAmount: 28_000,
    amenities: [],
  },
];

export interface SeededFixtures {
  cityIds: Record<'patna' | 'pune', string>;
  ownerId: string;
  /** Fixture key to listing id. */
  ids: Record<string, string>;
}

/**
 * Wipes and reseeds a small, fully deterministic dataset. Every listing sits a
 * known number of metres due north of its city's office point, so ring and
 * distance assertions are exact rather than approximate.
 */
export async function seedFixtures(): Promise<SeededFixtures> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE "ListingAmenity", "ListingImage", "ListingView", "Favorite",
      "EnquiryMessage", "Enquiry", "SavedSearch", "FuelPrice", "Listing",
      "OfficeLocation", "Amenity", "User", "City" RESTART IDENTITY CASCADE
  `);

  const patna = await prisma.city.create({
    data: {
      slug: 'patna',
      name: 'Patna',
      state: 'Bihar',
      centroidLat: PATNA_OFFICE.lat,
      centroidLng: PATNA_OFFICE.lng,
      bbox: { minLng: 84.9, minLat: 25.5, maxLng: 85.3, maxLat: 25.7 },
    },
  });

  const pune = await prisma.city.create({
    data: {
      slug: 'pune',
      name: 'Pune',
      state: 'Maharashtra',
      centroidLat: PUNE_OFFICE.lat,
      centroidLng: PUNE_OFFICE.lng,
      bbox: { minLng: 73.7, minLat: 18.4, maxLng: 74.0, maxLat: 18.6 },
    },
  });

  const owner = await prisma.user.create({
    data: { email: 'owner@test.local', name: 'Test Owner', role: 'EDITOR', emailVerified: true },
  });

  const amenities = await Promise.all(
    [
      { slug: 'lift', name: 'Lift', category: 'building' },
      { slug: 'parking', name: 'Parking', category: 'building' },
      { slug: 'power-backup', name: 'Power backup', category: 'utility' },
    ].map((data) => prisma.amenity.create({ data })),
  );
  const amenityIdBySlug = new Map(amenities.map((amenity) => [amenity.slug, amenity.id]));

  const cityIds = { patna: patna.id, pune: pune.id };
  const ids: Record<string, string> = {};

  for (const fixture of LISTING_FIXTURES) {
    const at = north(fixture.origin, fixture.meters);

    const created = await prisma.listing.create({
      data: {
        slug: fixture.key,
        ownerId: owner.id,
        cityId: cityIds[fixture.city],
        title: fixture.title,
        description: `${fixture.title} — fixture row.`,
        listingType: fixture.listingType,
        propertyType: fixture.propertyType,
        status: fixture.status,
        address: fixture.address,
        locality: fixture.address.split(',')[0] ?? 'Unknown',
        lat: at.lat,
        lng: at.lng,
        bedrooms: fixture.bedrooms,
        bathrooms: fixture.bathrooms,
        areaSqft: fixture.areaSqft,
        furnishing: fixture.furnishing,
        rentAmount: fixture.rentAmount ?? null,
        salePrice: fixture.salePrice ?? null,
        maintenanceMonthly: fixture.maintenanceMonthly ?? null,
        isVerified: fixture.isVerified ?? false,
        availableFrom: fixture.availableFrom ?? null,
        publishedAt: fixture.status === 'PUBLISHED' ? new Date() : null,
        amenities: {
          create: fixture.amenities.map((slug) => ({
            amenityId: amenityIdBySlug.get(slug) as string,
          })),
        },
      },
    });

    ids[fixture.key] = created.id;
  }

  return { cityIds, ownerId: owner.id, ids };
}
