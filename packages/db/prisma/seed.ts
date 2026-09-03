/**
 * Seeds three cities of realistic-looking rental data.
 *
 * Two properties this script guarantees, both of which matter more than they
 * sound:
 *
 *  - IDEMPOTENT. Everything upserts on a stable slug or composite key, so
 *    re-running never duplicates a row. Safe to run against a database that is
 *    already seeded, and safe to run twice by accident.
 *  - DETERMINISTIC. All "randomness" comes from a fixed-seed PRNG, so the same
 *    listings land at the same coordinates with the same prices on every
 *    machine. Screenshots, tests and bug reports stay comparable.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { hashPassword } from 'better-auth/crypto';
import { validateAndDerive, variantObjectKey } from '@machiya/shared/images';
import { CITIES, type CityConfig, type Locality } from '../../../scripts/cities.js';
import { prisma } from '../src/client.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIXTURE_DIR = join(REPO_ROOT, 'scripts', 'fixtures');

/** Known dev credentials. Documented in the README; never used in production. */
const DEV_PASSWORD = 'devpass123';

const DEV_USERS = [
  { email: 'seeker@dev.local', name: 'Sana Seeker', role: 'SEEKER' as const, city: 'patna' },
  { email: 'lister@dev.local', name: 'Lalit Lister', role: 'LISTER' as const, city: 'bengaluru' },
  { email: 'admin@dev.local', name: 'Asha Admin', role: 'ADMIN' as const, city: 'pune' },
];

const AMENITIES = [
  { slug: 'lift', name: 'Lift', icon: 'arrow-up-down', category: 'building' },
  { slug: 'parking', name: 'Covered parking', icon: 'car', category: 'building' },
  { slug: 'power-backup', name: 'Power backup', icon: 'zap', category: 'utility' },
  { slug: 'water-24x7', name: '24x7 water', icon: 'droplets', category: 'utility' },
  { slug: 'security', name: 'Gated security', icon: 'shield', category: 'safety' },
  { slug: 'cctv', name: 'CCTV', icon: 'video', category: 'safety' },
  { slug: 'gym', name: 'Gym', icon: 'dumbbell', category: 'lifestyle' },
  { slug: 'pool', name: 'Swimming pool', icon: 'waves', category: 'lifestyle' },
  { slug: 'park', name: 'Park', icon: 'trees', category: 'lifestyle' },
  { slug: 'clubhouse', name: 'Clubhouse', icon: 'landmark', category: 'lifestyle' },
  { slug: 'wifi', name: 'Wi-Fi ready', icon: 'wifi', category: 'utility' },
  { slug: 'modular-kitchen', name: 'Modular kitchen', icon: 'chef-hat', category: 'interior' },
  { slug: 'wardrobe', name: 'Fitted wardrobes', icon: 'shirt', category: 'interior' },
  { slug: 'balcony', name: 'Balcony', icon: 'sun', category: 'interior' },
  { slug: 'pet-friendly', name: 'Pet friendly', icon: 'paw-print', category: 'rules' },
  { slug: 'vegetarian-only', name: 'Vegetarian only', icon: 'salad', category: 'rules' },
];

const FIXTURE_IMAGES = [
  'exterior-01',
  'exterior-02',
  'exterior-03',
  'living-01',
  'living-02',
  'bedroom-01',
  'kitchen-01',
  'balcony-01',
];

const HOUSE_RULES = [
  'No smoking indoors',
  'Families preferred',
  'No loud music after 10pm',
  'Bachelors welcome',
  'Vegetarian tenants only',
  'Pets allowed with a deposit',
];

const PROPERTY_TYPES = [
  'APARTMENT',
  'APARTMENT',
  'BUILDER_FLOOR',
  'INDEPENDENT_HOUSE',
  'STUDIO',
  'VILLA',
  'PENTHOUSE',
  'PG',
] as const;

const FURNISHINGS = ['UNFURNISHED', 'SEMI_FURNISHED', 'FULLY_FURNISHED'] as const;

/** Rent per bedroom band, in whole rupees, roughly by city cost of living. */
const RENT_BASE: Record<string, number> = {
  patna: 6_500,
  bengaluru: 14_000,
  pune: 11_000,
};

/**
 * mulberry32. Small, fast, and — the only property that matters here — gives
 * the same sequence from the same seed on every machine.
 */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = createRandom(20260902);

function pickSome<T>(items: readonly T[], count: number): T[] {
  const pool = [...items];
  const chosen: T[] = [];
  while (chosen.length < count && pool.length > 0) {
    chosen.push(...pool.splice(Math.floor(random() * pool.length), 1));
  }
  return chosen;
}

function between(min: number, max: number): number {
  return min + random() * (max - min);
}

function roundTo(value: number, nearest: number): number {
  return Math.round(value / nearest) * nearest;
}

/**
 * A point jittered inside a locality rather than across the whole bounding box,
 * so markers cluster the way real listings do and the ring view has something
 * to show.
 */
function jitterWithin(locality: Locality, radiusMeters: number): { lat: number; lng: number } {
  const angle = random() * Math.PI * 2;
  const distance = Math.sqrt(random()) * radiusMeters;
  const latOffset = (distance * Math.cos(angle)) / 111_320;
  const lngOffset =
    (distance * Math.sin(angle)) / (111_320 * Math.cos((locality.lat * Math.PI) / 180));
  return { lat: locality.lat + latOffset, lng: locality.lng + lngOffset };
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// --- MinIO / S3 ------------------------------------------------------------

const s3 = new S3Client({
  region: process.env.S3_REGION ?? 'us-east-1',
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'true') === 'true',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'minioadmin',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'minioadmin',
  },
});

const BUCKET = process.env.S3_BUCKET ?? 'machiya-listings';

/**
 * Derives the fixture photos through the SAME pipeline the worker runs, then
 * uploads the variants under each image row's own keys.
 *
 * Two reasons not to shortcut this. The variant key layout is what the gallery
 * code exercises, so seeded data has to use it; and running the real
 * `validateAndDerive` means the seed would break if that code broke, instead of
 * quietly diverging from production behaviour.
 */
type DerivedFixture = Awaited<ReturnType<typeof validateAndDerive>>;

async function deriveFixtures(): Promise<DerivedFixture[]> {
  const derived: DerivedFixture[] = [];

  for (const name of FIXTURE_IMAGES) {
    const bytes = readFileSync(join(FIXTURE_DIR, `${name}.jpg`));
    derived.push(await validateAndDerive(bytes));
  }

  return derived;
}

async function uploadVariants(
  listingId: string,
  imageId: string,
  fixture: DerivedFixture,
): Promise<void> {
  await Promise.all(
    fixture.variants.map((variant) =>
      s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: variantObjectKey(listingId, imageId, variant.size, variant.extension),
          Body: variant.body,
          ContentType: variant.contentType,
          CacheControl: 'public, max-age=31536000, immutable',
        }),
      ),
    ),
  );
}

// --- reference data --------------------------------------------------------

async function seedAmenities(): Promise<Map<string, string>> {
  const ids = new Map<string, string>();

  for (const amenity of AMENITIES) {
    const row = await prisma.amenity.upsert({
      where: { slug: amenity.slug },
      create: amenity,
      update: { name: amenity.name, icon: amenity.icon, category: amenity.category },
    });
    ids.set(row.slug, row.id);
  }

  return ids;
}

async function seedCities(): Promise<Map<string, string>> {
  const ids = new Map<string, string>();

  for (const city of CITIES) {
    const data = {
      name: city.name,
      state: city.state,
      centroidLat: city.centroid.lat,
      centroidLng: city.centroid.lng,
      bbox: city.bbox,
      defaultFuelType: city.defaultFuelType,
      transitFareConfig: city.transitFare,
    };

    const row = await prisma.city.upsert({
      where: { slug: city.slug },
      create: { slug: city.slug, ...data },
      update: data,
    });
    ids.set(city.slug, row.id);

    // Localities are a table, not just literals in scripts/cities.ts, because
    // tier 1 of the autocomplete has to query them. This is the one place the
    // two are kept in step. See DECISIONS.md D39.
    for (const locality of city.localities) {
      const slug = slugify(locality.name);
      await prisma.locality.upsert({
        where: { cityId_slug: { cityId: row.id, slug } },
        create: { cityId: row.id, slug, name: locality.name, lat: locality.lat, lng: locality.lng },
        update: { name: locality.name, lat: locality.lat, lng: locality.lng },
      });
    }

    // A locality dropped from cities.ts must disappear from the table too, or a
    // renamed neighbourhood lingers as a suggestion nothing else knows about.
    await prisma.locality.deleteMany({
      where: {
        cityId: row.id,
        slug: { notIn: city.localities.map((locality) => slugify(locality.name)) },
      },
    });
  }

  return ids;
}

/**
 * Creates the three dev accounts with working passwords.
 *
 * The hash comes from Better Auth's own `hashPassword`, not a hand-rolled
 * scrypt call: if the library ever changes its format, these accounts change
 * with it instead of silently failing to sign in.
 */
async function seedUsers(
  cityIds: Map<string, string>,
): Promise<Map<string, { id: string; city: string }>> {
  const passwordHash = await hashPassword(DEV_PASSWORD);
  const users = new Map<string, { id: string; city: string }>();

  for (const dev of DEV_USERS) {
    const user = await prisma.user.upsert({
      where: { email: dev.email },
      create: {
        email: dev.email,
        name: dev.name,
        role: dev.role,
        emailVerified: true,
      },
      update: { name: dev.name, role: dev.role, emailVerified: true },
    });

    // One credential account per user. providerId/issuer match what Better Auth
    // writes for email+password sign-ups.
    const existing = await prisma.account.findFirst({
      where: { userId: user.id, providerId: 'credential' },
    });

    if (existing) {
      await prisma.account.update({ where: { id: existing.id }, data: { password: passwordHash } });
    } else {
      await prisma.account.create({
        data: {
          id: randomUUID(),
          accountId: user.id,
          userId: user.id,
          providerId: 'credential',
          issuer: 'local:credential',
          password: passwordHash,
        },
      });
    }

    const city = CITIES.find((candidate) => candidate.slug === dev.city);
    const locality = city?.localities[0];

    if (city && locality && cityIds.has(city.slug)) {
      const label = `${city.name} office`;
      const office = await prisma.officeLocation.findFirst({
        where: { userId: user.id, label },
      });

      const officeData = {
        address: `${locality.name}, ${city.name}, ${city.state}`,
        lat: locality.lat,
        lng: locality.lng,
        isDefault: true,
      };

      if (office) {
        await prisma.officeLocation.update({ where: { id: office.id }, data: officeData });
      } else {
        await prisma.officeLocation.create({
          data: { userId: user.id, label, ...officeData },
        });
      }
    }

    users.set(dev.email, { id: user.id, city: dev.city });
  }

  return users;
}

// --- listings --------------------------------------------------------------

interface PlannedListing {
  slug: string;
  city: CityConfig;
  locality: Locality;
  lat: number;
  lng: number;
  title: string;
  listingType: 'RENT' | 'SALE';
  propertyType: (typeof PROPERTY_TYPES)[number];
  status: 'DRAFT' | 'PUBLISHED' | 'PAUSED' | 'RENTED';
  furnishing: (typeof FURNISHINGS)[number];
  bedrooms: number;
  bathrooms: number;
  areaSqft: number;
  floor: number;
  totalFloors: number;
  rentAmount: number | null;
  salePrice: number | null;
  securityDeposit: number | null;
  maintenanceMonthly: number | null;
  availableFrom: Date | null;
  isVerified: boolean;
  rules: string[];
  amenitySlugs: string[];
}

/** 17 listings per city: 51 in total, spread across every enum value. */
function planListings(city: CityConfig, index: number): PlannedListing[] {
  const planned: PlannedListing[] = [];
  const perCity = 17;

  // Localities sit 5-20 km apart, so spreading listings evenly across all of
  // them leaves only three or four inside any 3 km office radius — which is the
  // one view this whole app is built around. Two thirds are therefore clustered
  // on the first two localities (where seedUsers puts each dev office) and the
  // rest spread over the others, so the ring view has something to show AND the
  // wider city is still populated.
  const nearOffice = Math.round(perCity * 0.65);

  for (let n = 0; n < perCity; n += 1) {
    const locality = (
      n < nearOffice
        ? city.localities[n % 2]
        : city.localities[2 + ((n - nearOffice) % Math.max(1, city.localities.length - 2))]
    ) as Locality;

    const point = jitterWithin(locality, n < nearOffice ? 1_800 : 1_400);

    const bedrooms = 1 + (n % 4);
    const bathrooms = Math.max(1, bedrooms - (n % 2));
    const areaSqft = roundTo(320 + bedrooms * between(320, 460), 10);
    const propertyType = PROPERTY_TYPES[
      n % PROPERTY_TYPES.length
    ] as (typeof PROPERTY_TYPES)[number];
    const furnishing = FURNISHINGS[n % FURNISHINGS.length] as (typeof FURNISHINGS)[number];

    // Roughly a quarter of the stock is for sale.
    const listingType = n % 4 === 3 ? 'SALE' : 'RENT';

    // One draft per city, one paused and one rented across the whole set.
    let status: PlannedListing['status'] = 'PUBLISHED';
    if (n === perCity - 1) status = 'DRAFT';
    else if (n === 4 && index === 0) status = 'RENTED';
    else if (n === 6 && index === 1) status = 'PAUSED';

    const base = RENT_BASE[city.slug] ?? 10_000;
    const rent = roundTo(base * bedrooms * between(0.75, 1.5), 500);
    const isSale = listingType === 'SALE';

    const title = `${bedrooms} BHK ${propertyType === 'PG' ? 'PG' : propertyType.toLowerCase().replace(/_/g, ' ')} in ${locality.name}`;

    planned.push({
      slug: `${city.slug}-${slugify(locality.name)}-${bedrooms}bhk-${String(n + 1).padStart(2, '0')}`,
      city,
      locality,
      lat: point.lat,
      lng: point.lng,
      title: title.charAt(0).toUpperCase() + title.slice(1),
      listingType,
      propertyType,
      status,
      furnishing,
      bedrooms,
      bathrooms,
      areaSqft,
      floor: 1 + (n % 8),
      totalFloors: 8 + (n % 5),
      rentAmount: isSale ? null : rent,
      salePrice: isSale ? roundTo(rent * between(300, 420), 50_000) : null,
      securityDeposit: isSale ? null : rent * (2 + (n % 2)),
      maintenanceMonthly: n % 3 === 0 ? roundTo(rent * 0.06, 100) : null,
      availableFrom: n % 5 === 0 ? null : new Date(Date.now() + (n % 45) * 24 * 60 * 60 * 1000),
      isVerified: n % 3 === 0,
      rules: pickSome(HOUSE_RULES, 1 + (n % 3)),
      amenitySlugs: pickSome(
        AMENITIES.map((amenity) => amenity.slug),
        3 + (n % 5),
      ),
    });
  }

  return planned;
}

async function seedListings(
  cityIds: Map<string, string>,
  amenityIds: Map<string, string>,
  ownerId: string,
  fixtures: DerivedFixture[],
): Promise<string[]> {
  const listingIds: string[] = [];
  const plannedSlugs: string[] = [];

  for (const [index, city] of CITIES.entries()) {
    const cityId = cityIds.get(city.slug);
    if (!cityId) continue;

    for (const plan of planListings(city, index)) {
      const data = {
        ownerId,
        cityId,
        title: plan.title,
        description: [
          `${plan.title}, in ${plan.locality.name}.`,
          '',
          `${plan.areaSqft} sq ft on floor ${plan.floor} of ${plan.totalFloors}, ${plan.furnishing.toLowerCase().replace(/_/g, ' ')}.`,
          'Seed data: the address and photos are placeholders, the geometry is real.',
        ].join('\n'),
        listingType: plan.listingType,
        propertyType: plan.propertyType,
        status: plan.status,
        address: `${plan.locality.name}, ${city.name}, ${city.state}`,
        locality: plan.locality.name,
        lat: plan.lat,
        lng: plan.lng,
        bedrooms: plan.bedrooms,
        bathrooms: plan.bathrooms,
        floor: plan.floor,
        totalFloors: plan.totalFloors,
        areaSqft: plan.areaSqft,
        furnishing: plan.furnishing,
        rentAmount: plan.rentAmount,
        salePrice: plan.salePrice,
        securityDeposit: plan.securityDeposit,
        maintenanceMonthly: plan.maintenanceMonthly,
        availableFrom: plan.availableFrom,
        isVerified: plan.isVerified,
        rules: plan.rules,
        publishedAt: plan.status === 'DRAFT' ? null : new Date(),
      };

      const listing = await prisma.listing.upsert({
        where: { slug: plan.slug },
        create: { slug: plan.slug, ...data },
        update: data,
      });

      plannedSlugs.push(plan.slug);
      listingIds.push(listing.id);

      // Replace rather than merge, so a re-run cannot accumulate amenities.
      await prisma.listingAmenity.deleteMany({ where: { listingId: listing.id } });
      await prisma.listingAmenity.createMany({
        data: plan.amenitySlugs
          .map((slug) => amenityIds.get(slug))
          .filter((id): id is string => Boolean(id))
          .map((amenityId) => ({ listingId: listing.id, amenityId })),
        skipDuplicates: true,
      });

      await prisma.listingImage.deleteMany({ where: { listingId: listing.id } });

      const chosen = pickSome(fixtures, 4);
      for (const [position, fixture] of chosen.entries()) {
        const image = await prisma.listingImage.create({
          data: {
            listingId: listing.id,
            // Seeded photos skip the upload path entirely, so there is no
            // original to keep — they go straight in as READY.
            objectKey: null,
            status: 'READY',
            width: fixture.width,
            height: fixture.height,
            dominantColor: fixture.dominantColor,
            lqip: fixture.lqip,
            sortOrder: position,
            isCover: position === 0,
            processedAt: new Date(),
          },
        });

        await uploadVariants(listing.id, image.id, fixture);
      }
    }
  }

  // Upsert-by-slug alone is not idempotent across a CHANGE to the plan: edit how
  // listings are laid out and the new slugs are inserted while the old rows stay
  // behind as orphans. (Observed: 51 listings became 90.) Everything the seed
  // creates belongs to the dev lister, so anything of theirs not in the current
  // plan is stale and goes — cascades take its images, amenities, enquiries and
  // favourites with it.
  const removed = await prisma.listing.deleteMany({
    where: { ownerId, slug: { notIn: plannedSlugs } },
  });

  if (removed.count > 0) {
    console.log(`  pruned     ${removed.count} listing(s) no longer in the plan`);
  }

  return listingIds;
}

// --- engagement: enquiries, favourites, saved searches ---------------------

async function seedEngagement(
  users: Map<string, { id: string; city: string }>,
  listingIds: string[],
  listerId: string,
): Promise<{ enquiries: number; favorites: number; savedSearches: number }> {
  const seeker = users.get('seeker@dev.local');
  const admin = users.get('admin@dev.local');
  if (!seeker) return { enquiries: 0, favorites: 0, savedSearches: 0 };

  const targets = listingIds.slice(0, 4);
  let enquiries = 0;

  for (const [index, listingId] of targets.entries()) {
    const seekerId = index % 2 === 0 || !admin ? seeker.id : admin.id;

    // One thread per (listing, seeker) — the schema enforces it, so upsert.
    const enquiry = await prisma.enquiry.upsert({
      where: { listingId_seekerId: { listingId, seekerId } },
      create: {
        listingId,
        seekerId,
        listerId,
        status: index === 0 ? 'RESPONDED' : 'OPEN',
        lastMessageAt: new Date(Date.now() - index * 3_600_000),
      },
      update: { status: index === 0 ? 'RESPONDED' : 'OPEN' },
    });
    enquiries += 1;

    // Messages have no natural key, so clear the thread before refilling it.
    await prisma.enquiryMessage.deleteMany({ where: { enquiryId: enquiry.id } });
    await prisma.enquiryMessage.createMany({
      data: [
        {
          enquiryId: enquiry.id,
          senderId: seekerId,
          body: 'Hi — is this still available, and is the deposit negotiable?',
          createdAt: new Date(Date.now() - index * 3_600_000 - 7_200_000),
          readAt: new Date(Date.now() - index * 3_600_000 - 6_000_000),
        },
        ...(index === 0
          ? [
              {
                enquiryId: enquiry.id,
                senderId: listerId,
                body: 'Yes, available from next month. Deposit is two months, slightly flexible.',
                createdAt: new Date(Date.now() - 3_000_000),
                readAt: null,
              },
            ]
          : []),
      ],
    });
  }

  const favouriteIds = listingIds.slice(1, 7);
  for (const listingId of favouriteIds) {
    await prisma.favorite.upsert({
      where: { userId_listingId: { userId: seeker.id, listingId } },
      create: { userId: seeker.id, listingId },
      update: {},
    });
  }

  const patna = CITIES[0] as CityConfig;
  const bengaluru = CITIES[1] as CityConfig;

  const searches = [
    {
      name: 'Under 15k near the Patna office',
      filters: { listingType: 'RENT', priceMax: 15_000, bedroomsMin: 2 },
      officeLat: patna.localities[0]?.lat ?? patna.centroid.lat,
      officeLng: patna.localities[0]?.lng ?? patna.centroid.lng,
      radiusMeters: 3_000,
      notifyEnabled: true,
    },
    {
      name: 'Furnished 3BHK in Bengaluru',
      filters: {
        listingType: 'RENT',
        bedroomsMin: 3,
        furnishing: ['FULLY_FURNISHED', 'SEMI_FURNISHED'],
      },
      officeLat: bengaluru.localities[0]?.lat ?? bengaluru.centroid.lat,
      officeLng: bengaluru.localities[0]?.lng ?? bengaluru.centroid.lng,
      radiusMeters: 2_000,
      notifyEnabled: false,
    },
  ];

  for (const search of searches) {
    const existing = await prisma.savedSearch.findFirst({
      where: { userId: seeker.id, name: search.name },
    });

    if (existing) {
      await prisma.savedSearch.update({ where: { id: existing.id }, data: search });
    } else {
      await prisma.savedSearch.create({ data: { userId: seeker.id, ...search } });
    }
  }

  return { enquiries, favorites: favouriteIds.length, savedSearches: searches.length };
}

// --- views ------------------------------------------------------------------

/**
 * Backdated view rows, so the lister's analytics panel has a shape rather than
 * a flat line on a fresh seed.
 *
 * `Listing.viewCount` is set to match the rows written, because the two are
 * separate by design — the counter is what the search query reads and the rows
 * are what the chart aggregates — and a seed that disagreed with itself would
 * look like a bug in whichever one you checked second.
 *
 * Deleted and rewritten rather than upserted: a view has no natural key, so
 * re-running the seed would otherwise pile up a new fortnight of history every
 * time.
 */
async function seedListingViews(
  listingIds: string[],
  users: Map<string, { id: string; city: string }>,
): Promise<number> {
  const viewerIds = [...users.values()].map((user) => user.id);
  const dayMs = 86_400_000;

  await prisma.listingView.deleteMany({ where: { listingId: { in: listingIds } } });

  const rows: Array<{ listingId: string; userId: string | null; viewedAt: Date }> = [];

  for (const [index, listingId] of listingIds.entries()) {
    // The first listings in the plan are the ones the enquiries and favourites
    // point at, so give them the most traffic: a dashboard where every row has
    // the same number teaches nothing.
    const popularity = index < 6 ? between(18, 40) : index < 20 ? between(4, 16) : between(0, 5);
    const total = Math.round(popularity);

    for (let n = 0; n < total; n += 1) {
      // Weighted towards recent: squaring a uniform sample bunches it near 0.
      const daysAgo = Math.floor(random() ** 2 * 14);
      const viewer =
        random() < 0.45 ? (viewerIds[Math.floor(random() * viewerIds.length)] ?? null) : null;

      rows.push({
        listingId,
        userId: viewer,
        viewedAt: new Date(Date.now() - daysAgo * dayMs - Math.floor(random() * dayMs)),
      });
    }
  }

  if (rows.length > 0) {
    await prisma.listingView.createMany({ data: rows });
  }

  // Keep the denormalised counter honest.
  const counts = await prisma.listingView.groupBy({
    by: ['listingId'],
    where: { listingId: { in: listingIds } },
    _count: { _all: true },
  });

  for (const row of counts) {
    await prisma.listing.update({
      where: { id: row.listingId },
      data: { viewCount: row._count._all },
    });
  }

  return rows.length;
}

// --- fuel prices -----------------------------------------------------------

/**
 * Current-ish prices so commute cost works before the scraper's first run.
 *
 * fetchedAt is truncated to the hour, which makes the (cityId, fuelType,
 * fetchedAt) unique key stable across re-runs within the same hour rather than
 * inserting a near-duplicate row every time.
 */
async function seedFuelPrices(cityIds: Map<string, string>): Promise<number> {
  const fetchedAt = new Date();
  fetchedAt.setMinutes(0, 0, 0);

  const perCity: Record<string, { PETROL: number; DIESEL: number; CNG: number }> = {
    patna: { PETROL: 107.24, DIESEL: 94.04, CNG: 89.5 },
    bengaluru: { PETROL: 102.86, DIESEL: 88.94, CNG: 86.5 },
    pune: { PETROL: 104.21, DIESEL: 90.68, CNG: 84.0 },
  };

  let written = 0;

  for (const city of CITIES) {
    const cityId = cityIds.get(city.slug);
    const prices = perCity[city.slug];
    if (!cityId || !prices) continue;

    for (const [fuelType, price] of Object.entries(prices)) {
      await prisma.fuelPrice.upsert({
        where: {
          cityId_fuelType_fetchedAt: {
            cityId,
            fuelType: fuelType as 'PETROL' | 'DIESEL' | 'CNG',
            fetchedAt,
          },
        },
        create: {
          cityId,
          fuelType: fuelType as 'PETROL' | 'DIESEL' | 'CNG',
          price,
          source: 'seed',
          sourceUrl: 'https://github.com/Kunal-jaiswal972/Machiya',
          fetchedAt,
        },
        update: { price },
      });
      written += 1;
    }
  }

  return written;
}

// --- entrypoint ------------------------------------------------------------

async function main(): Promise<void> {
  const startedAt = Date.now();
  console.log('seeding three cities…');

  const fixtures = await deriveFixtures();
  console.log(
    `  images     ${fixtures.length} fixtures derived into ${fixtures[0]?.variants.length ?? 0} variants each`,
  );

  const amenityIds = await seedAmenities();
  console.log(`  amenities  ${amenityIds.size}`);

  const cityIds = await seedCities();
  console.log(`  cities     ${[...cityIds.keys()].join(', ')}`);

  const users = await seedUsers(cityIds);
  console.log(`  users      ${[...users.keys()].join(', ')} (password: ${DEV_PASSWORD})`);

  const lister = users.get('lister@dev.local');
  if (!lister) throw new Error('lister@dev.local was not created');

  const listingIds = await seedListings(cityIds, amenityIds, lister.id, fixtures);
  console.log(`  listings   ${listingIds.length} across ${cityIds.size} cities`);

  const engagement = await seedEngagement(users, listingIds, lister.id);
  console.log(
    `  activity   ${engagement.enquiries} enquiries, ${engagement.favorites} favourites, ${engagement.savedSearches} saved searches`,
  );

  const views = await seedListingViews(listingIds, users);
  console.log(`  views      ${views} listing views over the last 14 days`);

  const fuelRows = await seedFuelPrices(cityIds);
  console.log(`  fuel       ${fuelRows} price rows`);

  const byStatus = await prisma.listing.groupBy({ by: ['status'], _count: { _all: true } });
  const summary = byStatus.map((row) => `${row.status.toLowerCase()}=${row._count._all}`).join(' ');
  console.log(`\ndone in ${((Date.now() - startedAt) / 1000).toFixed(1)}s — ${summary}`);
}

main()
  .catch((error: unknown) => {
    console.error('\nseed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
