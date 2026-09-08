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
import { existsSync, readFileSync } from 'node:fs';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { hashPassword } from 'better-auth/crypto';
import { fixtureVariantBaseKey, validateAndDerive, variantObjectKey } from '@machiya/shared/images';
import { CITIES, type CityConfig, type Locality } from '@machiya/shared/cities';
import { HOUSE_RULE_LABELS } from '@machiya/shared';
import {
  photoFilePath,
  readPhotoManifest,
  type SeedPhoto,
} from '../../../scripts/fetch-seed-photos.js';
import { prisma } from '../src/client.js';

/** Known dev credentials. Documented in the README; never used in production. */
const DEV_PASSWORD = 'devpass123';

/**
 * Two of each role, so every permission boundary has a second party to test
 * against: one editor cannot edit the other's listing, one user cannot read the
 * other's enquiries. A single account per role can only ever prove that the
 * owner is allowed in. All in Patna — the seed covers one city (D91).
 */
const DEV_USERS = [
  { email: 'user@dev.local', name: 'Sana User', role: 'USER' as const, city: 'patna' },
  { email: 'user2@dev.local', name: 'Sameer User', role: 'USER' as const, city: 'patna' },
  { email: 'editor@dev.local', name: 'Lalit Editor', role: 'EDITOR' as const, city: 'patna' },
  { email: 'editor2@dev.local', name: 'Leena Editor', role: 'EDITOR' as const, city: 'patna' },
  { email: 'admin@dev.local', name: 'Asha Admin', role: 'ADMIN' as const, city: 'patna' },
  { email: 'admin2@dev.local', name: 'Arun Admin', role: 'ADMIN' as const, city: 'patna' },
];

/** The editors that own seeded stock, in the order listings are dealt to them. */
const SEED_OWNERS = ['editor@dev.local', 'editor2@dev.local'];

/**
 * `icon` is a lucide export name in PascalCase, not a kebab slug: the web app
 * resolves it through one registry shared with the house rules, so a name that
 * is not exported renders the neutral fallback rather than nothing.
 */
const AMENITIES = [
  { slug: 'lift', name: 'Lift', icon: 'ArrowUpDown', category: 'building' },
  { slug: 'parking', name: 'Covered parking', icon: 'SquareParking', category: 'building' },
  { slug: 'garage', name: 'Garage available', icon: 'Warehouse', category: 'building' },
  { slug: 'visitor-parking', name: 'Visitor parking', icon: 'CarFront', category: 'building' },
  { slug: 'bike-parking', name: 'Two-wheeler parking', icon: 'Bike', category: 'building' },
  { slug: 'step-free', name: 'Step-free access', icon: 'Accessibility', category: 'building' },
  { slug: 'power-backup', name: 'Power backup', icon: 'Zap', category: 'utility' },
  { slug: 'water-24x7', name: '24x7 water', icon: 'Droplets', category: 'utility' },
  { slug: 'borewell', name: 'Borewell supply', icon: 'Container', category: 'utility' },
  { slug: 'wifi', name: 'Wi-Fi ready', icon: 'Wifi', category: 'utility' },
  { slug: 'piped-gas', name: 'Piped gas', icon: 'Flame', category: 'utility' },
  {
    slug: 'waste-collection',
    name: 'Daily waste collection',
    icon: 'Recycle',
    category: 'utility',
  },
  { slug: 'security', name: 'Gated security', icon: 'Shield', category: 'safety' },
  { slug: 'cctv', name: 'CCTV', icon: 'Video', category: 'safety' },
  { slug: 'intercom', name: 'Intercom', icon: 'DoorOpen', category: 'safety' },
  { slug: 'fire-safety', name: 'Fire safety', icon: 'ShieldCheck', category: 'safety' },
  { slug: 'gym', name: 'Gym', icon: 'Dumbbell', category: 'lifestyle' },
  { slug: 'pool', name: 'Swimming pool', icon: 'Waves', category: 'lifestyle' },
  { slug: 'park', name: 'Park', icon: 'Trees', category: 'lifestyle' },
  { slug: 'clubhouse', name: 'Clubhouse', icon: 'Landmark', category: 'lifestyle' },
  { slug: 'play-area', name: "Children's play area", icon: 'Baby', category: 'lifestyle' },
  { slug: 'terrace', name: 'Shared terrace', icon: 'Sun', category: 'lifestyle' },
  { slug: 'modular-kitchen', name: 'Modular kitchen', icon: 'ChefHat', category: 'interior' },
  { slug: 'wardrobe', name: 'Fitted wardrobes', icon: 'Shirt', category: 'interior' },
  { slug: 'balcony', name: 'Balcony', icon: 'Sun', category: 'interior' },
  { slug: 'air-conditioning', name: 'Air conditioning', icon: 'AirVent', category: 'interior' },
  { slug: 'geyser', name: 'Geyser', icon: 'Bath', category: 'interior' },
  {
    slug: 'washing-machine',
    name: 'Washing machine',
    icon: 'WashingMachine',
    category: 'interior',
  },
  { slug: 'refrigerator', name: 'Refrigerator', icon: 'Refrigerator', category: 'interior' },
  { slug: 'furnished-beds', name: 'Beds provided', icon: 'BedDouble', category: 'interior' },
  { slug: 'sofa', name: 'Living room seating', icon: 'Sofa', category: 'interior' },
  { slug: 'tv', name: 'Television', icon: 'Tv', category: 'interior' },
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
/**
 * Local prices, per square foot, because that is how the market quotes them and
 * how a rent stays consistent with the area printed beside it.
 *
 * The previous version priced rent from a per-bedroom base and then derived a
 * sale price as 300-420x the monthly rent. That second step is what broke: a
 * 4 BHK came out at roughly fifteen crore in Patna, which is not a number any
 * listing there carries, and it made the buy half of the seed useless for
 * eyeballing a price filter. Sale price is now its own per-sqft band.
 *
 * Patna bands sanity-checked against the shape of the local market: a ~1,000
 * sqft 2 BHK lands near ₹9,000-15,000 to rent and ₹32-55 lakh to buy. See D91.
 */
const PRICE_PER_SQFT: Record<string, { rent: [number, number]; sale: [number, number] }> = {
  patna: { rent: [9, 15], sale: [3_200, 5_500] },
  bengaluru: { rent: [18, 30], sale: [6_500, 11_000] },
  pune: { rent: [15, 26], sale: [6_000, 9_500] },
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

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(random() * items.length)] as T;
}

/**
 * One value from `[value, weight]` pairs. Weights need not sum to 1; whatever
 * they sum to is the denominator, so a pair can be added without rebalancing
 * the rest.
 */
function pickWeighted<T>(choices: readonly [T, number][]): T {
  const total = choices.reduce((sum, [, weight]) => sum + weight, 0);
  let threshold = random() * total;

  for (const [value, weight] of choices) {
    threshold -= weight;
    if (threshold <= 0) return value;
  }

  return choices[choices.length - 1]?.[0] as T;
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
 * Loads the seed photos and derives each one ONCE, through the same
 * `validateAndDerive` the worker runs.
 *
 * Two reasons not to shortcut the real pipeline: the variant key layout is what
 * the gallery code exercises, so seeded data has to use it; and running the real
 * derivation means the seed breaks if that code breaks, rather than quietly
 * diverging from production behaviour.
 *
 * The variants are uploaded once under `variants/fixtures/{photoId}/` and shared
 * across every listing that uses the photo — 23 photos rather than one private
 * copy per listing, which would be ~1,200 objects of identical bytes. See D41.
 */
interface SeedFixture {
  photo: SeedPhoto;
  derived: Awaited<ReturnType<typeof validateAndDerive>>;
  variantBaseKey: string;
}

async function loadFixtures(): Promise<SeedFixture[]> {
  const manifest = readPhotoManifest();

  if (!manifest) {
    throw new Error(
      [
        'No seed photos. Run `pnpm seed:photos` first — it writes',
        'scripts/fixtures/photos.json and caches the images. With a key in',
        'UNSPLASH_ACCESS_KEY it uses the Unsplash API; without one it falls back to',
        'fixed picsum.photos ids. Either way the manifest is committed, so the seed',
        'is reproducible afterwards with no network at all.',
      ].join(' '),
    );
  }

  const fixtures: SeedFixture[] = [];

  for (const photo of manifest.photos) {
    const path = photoFilePath(photo);

    if (!existsSync(path)) {
      throw new Error(
        `Seed photo ${photo.id} is in the manifest but not cached at ${path}. ` +
          'Run `pnpm seed:photos` — it downloads only what is missing.',
      );
    }

    const derived = await validateAndDerive(readFileSync(path));
    fixtures.push({ photo, derived, variantBaseKey: fixtureVariantBaseKey(photo.id) });
  }

  return fixtures;
}

/** Uploads one photo's variants to the shared fixture prefix. */
async function uploadFixture(fixture: SeedFixture): Promise<void> {
  await Promise.all(
    fixture.derived.variants.map((variant) =>
      s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: variantObjectKey(fixture.variantBaseKey, variant.size, variant.extension),
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

    // The boundary polygon needs raw SQL twice over: Prisma can neither write
    // nor read an `Unsupported()` column, and the value is GeoJSON that has to
    // go through ST_GeomFromGeoJSON. `ST_Multi` because the schema column is a
    // MultiPolygon while Nominatim returns whichever of the two the relation
    // happens to be — normalising here means the containment query never has
    // to care. `ST_MakeValid` because a simplified ring can self-intersect, and
    // PostGIS would accept the geometry and then silently never match it.
    if (city.boundary) {
      // Only `type` and `coordinates` — the record also carries provenance
      // (source, osmId, point counts), and ST_GeomFromGeoJSON is entitled to
      // reject members it does not recognise.
      const geojson = JSON.stringify({
        type: city.boundary.type,
        coordinates: city.boundary.coordinates,
      });

      await prisma.$executeRaw`
        UPDATE "City"
        SET "boundary" = ST_Multi(
          ST_MakeValid(ST_GeomFromGeoJSON(${geojson}::json))
        )::geography
        WHERE "id" = ${row.id}
      `;
    } else {
      // Not a warning here: `pnpm cities:validate` reports it per city with the
      // command that fixes it, and repeating it on every seed would train
      // people to ignore seed output.
      await prisma.$executeRaw`UPDATE "City" SET "boundary" = NULL WHERE "id" = ${row.id}`;
    }

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

/**
 * The cities the seed populates.
 *
 * Patna only. Bengaluru and Pune stay in `CITIES` — the OSM artifacts, the
 * coverage set and `validate-cities` are all built from that list and removing
 * a city there means a 40-minute rebuild — but they get no listings, so the
 * product is developed against one city with real depth rather than three with
 * a token handful each. See DECISIONS.md D91.
 */
const SEEDED_CITY_SLUGS = ['patna'];

/** 100 listings, all in Patna, spread across every enum value. */
function planListings(city: CityConfig): PlannedListing[] {
  const planned: PlannedListing[] = [];
  const perCity = 100;

  // Localities sit 5-20 km apart, so spreading listings evenly across all of
  // them leaves only three or four inside any 3 km office radius — which is the
  // one view this whole app is built around. Seventy percent are therefore
  // clustered on the first two localities (where seedUsers puts each dev office)
  // and the rest spread over the others, so the ring view has something real to
  // show AND the wider city is still populated for a different office.
  //
  // 40 per city rather than a token handful for two reasons: a product whose
  // argument is "look how many homes are near your office" cannot make it with
  // five pins, and the design's own performance bar — 60 markers on screen at
  // 60fps while dragging the office pin — needs 60 markers to exist.
  const nearOffice = Math.round(perCity * 0.7);

  for (let n = 0; n < perCity; n += 1) {
    const locality = (
      n < nearOffice
        ? // Two thirds of the near-office cluster on the office's OWN locality
          // and a third on the neighbouring one, rather than an even split: the
          // second locality is 3-5 km away, so an even split puts half the
          // cluster outside the radius it exists to fill.
          city.localities[n % 3 === 2 ? 1 : 0]
        : city.localities[2 + ((n - nearOffice) % Math.max(1, city.localities.length - 2))]
    ) as Locality;

    const point = jitterWithin(locality, n < nearOffice ? 2_200 : 1_400);

    // Drawn from the seeded PRNG rather than from `n % k`. The modulo version
    // produced a grid — every fourth listing identical in bedrooms, furnishing
    // and property type marching in lockstep — which reads as fake and hides
    // the bugs that only a lopsided distribution finds. `random` is mulberry32
    // from a fixed seed, so this is varied AND identical on every machine.
    const bedrooms = pickWeighted([
      [1, 0.22],
      [2, 0.38],
      [3, 0.28],
      [4, 0.12],
    ]);
    const bathrooms = Math.max(1, bedrooms - (random() < 0.6 ? 1 : 0));
    const areaSqft = roundTo(280 + bedrooms * between(300, 480), 10);
    const propertyType = pick(PROPERTY_TYPES);
    const furnishing = pick(FURNISHINGS);

    // An even split. The product's argument is total monthly cost, which only
    // has a rent side — but the buy side has to be populated enough to notice
    // when a price or a filter regresses on it, and a quarter of the stock was
    // not (D91).
    const listingType = n % 2 === 0 ? 'RENT' : 'SALE';

    // A handful of non-published rows so the dashboard's filters and the
    // wizard's resume path have something to act on. Everything else is
    // PUBLISHED, because the search is what most work touches.
    let status: PlannedListing['status'] = 'PUBLISHED';
    if (n >= perCity - 3) status = 'DRAFT';
    else if (n % 37 === 4) status = 'RENTED';
    else if (n % 41 === 6) status = 'PAUSED';

    const bands = PRICE_PER_SQFT[city.slug] ?? PRICE_PER_SQFT.patna;
    if (!bands) throw new Error(`no price band for ${city.slug}`);
    const rent = roundTo(areaSqft * between(bands.rent[0], bands.rent[1]), 500);
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
      floor: 1 + Math.floor(between(0, 8)),
      totalFloors: 6 + Math.floor(between(0, 7)),
      rentAmount: isSale ? null : rent,
      salePrice: isSale ? roundTo(areaSqft * between(bands.sale[0], bands.sale[1]), 50_000) : null,
      securityDeposit: isSale ? null : rent * (random() < 0.65 ? 2 : 3),
      maintenanceMonthly: random() < 0.45 ? roundTo(rent * between(0.03, 0.08), 100) : null,
      availableFrom:
        random() < 0.2
          ? null
          : new Date(Date.now() + Math.floor(between(0, 60)) * 24 * 60 * 60 * 1000),
      isVerified: random() < 0.35,
      rules: pickSome(HOUSE_RULE_LABELS, Math.floor(between(1, 6.99))),
      amenitySlugs: pickSome(
        AMENITIES.map((amenity) => amenity.slug),
        Math.floor(between(4, 12.99)),
      ),
    });
  }

  return planned;
}

async function seedListings(
  cityIds: Map<string, string>,
  amenityIds: Map<string, string>,
  ownerIds: string[],
  fixtures: SeedFixture[],
): Promise<string[]> {
  const listingIds: string[] = [];
  const plannedSlugs: string[] = [];
  let dealt = 0;

  for (const city of CITIES.filter((candidate) => SEEDED_CITY_SLUGS.includes(candidate.slug))) {
    const cityId = cityIds.get(city.slug);
    if (!cityId) continue;

    for (const plan of planListings(city)) {
      // Dealt round-robin so both editors own real stock: a dashboard with one
      // owner's listings cannot show that the other's are invisible to them.
      const ownerId = ownerIds[dealt % ownerIds.length] as string;
      dealt += 1;

      const data = {
        ownerId,
        cityId,
        title: plan.title,
        description: [
          `${plan.title}, in ${plan.locality.name}.`,
          '',
          `${plan.areaSqft} sq ft on floor ${plan.floor} of ${plan.totalFloors}, ${plan.furnishing.toLowerCase().replace(/_/g, ' ')}.`,
          // No line saying this is seeded: it renders verbatim in the About
          // section, and a demo that narrates its own fixtures is not a demo.
          'Close to the main road, with a market and a chemist within walking distance.',
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

      // 3-6 photos per listing, drawn from the shared pool by the same PRNG as
      // everything else, so the assignment is stable across runs. An exterior
      // shot is preferred for the cover when the draw contains one — a gallery
      // that opens on a close-up of a tap reads as a mistake.
      const chosen = pickSome(fixtures, Math.floor(between(3, 6.99)));
      const exteriorFirst = [
        ...chosen.filter((fixture) => fixture.photo.tag === 'exterior'),
        ...chosen.filter((fixture) => fixture.photo.tag !== 'exterior'),
      ];

      for (const [position, fixture] of exteriorFirst.entries()) {
        await prisma.listingImage.create({
          data: {
            listingId: listing.id,
            // Seeded photos skip the upload path entirely, so there is no
            // original to keep — they go straight in as READY.
            objectKey: null,
            // The shared fixture prefix, not this listing's own: one copy of
            // each photo serves every listing that draws it. See D41.
            variantBaseKey: fixture.variantBaseKey,
            status: 'READY',
            width: fixture.derived.width,
            height: fixture.derived.height,
            dominantColor: fixture.derived.dominantColor,
            lqip: fixture.derived.lqip,
            sortOrder: position,
            isCover: position === 0,
            processedAt: new Date(),
          },
        });
      }
    }
  }

  // Upsert-by-slug alone is not idempotent across a CHANGE to the plan: edit how
  // listings are laid out and the new slugs are inserted while the old rows stay
  // behind as orphans. (Observed: 51 listings became 90.) Everything the seed
  // creates belongs to a dev editor, so anything of theirs not in the current
  // plan is stale and goes — cascades take its images, amenities, enquiries and
  // favourites with it. Rows owned by a REAL account are never in scope.
  const removed = await prisma.listing.deleteMany({
    where: { ownerId: { in: ownerIds }, slug: { notIn: plannedSlugs } },
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
  const seeker = users.get('user@dev.local');
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
  console.log(`seeding ${SEEDED_CITY_SLUGS.join(', ')}…`);

  const fixtures = await loadFixtures();
  for (const fixture of fixtures) {
    await uploadFixture(fixture);
  }
  console.log(
    `  photos     ${String(fixtures.length)} shared photos, ${String(fixtures[0]?.derived.variants.length ?? 0)} variants each, under variants/fixtures/`,
  );

  const amenityIds = await seedAmenities();
  console.log(`  amenities  ${amenityIds.size}`);

  const cityIds = await seedCities();
  console.log(`  cities     ${[...cityIds.keys()].join(', ')}`);

  const users = await seedUsers(cityIds);
  console.log(`  users      ${[...users.keys()].join(', ')} (password: ${DEV_PASSWORD})`);

  const owners = SEED_OWNERS.map((email) => {
    const owner = users.get(email);
    if (!owner) throw new Error(`${email} was not created`);
    return owner.id;
  });

  const lister = users.get('editor@dev.local');
  if (!lister) throw new Error('editor@dev.local was not created');

  const listingIds = await seedListings(cityIds, amenityIds, owners, fixtures);
  console.log(
    `  listings   ${listingIds.length} in ${SEEDED_CITY_SLUGS.join(', ')}, across ${owners.length} editors`,
  );

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
