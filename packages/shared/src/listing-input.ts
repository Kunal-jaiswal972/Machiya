import { z } from 'zod';
import {
  furnishingTypeSchema,
  imageStatusSchema,
  listingStatusSchema,
  listingTypeSchema,
  propertyTypeSchema,
} from './enums.js';
import { latitudeSchema, longitudeSchema } from './geo/index.js';

/**
 * What a lister may send when creating or editing a listing.
 *
 * Deliberately narrower than the Prisma model: `ownerId`, `status`,
 * `isVerified`, `viewCount` and `publishedAt` are all absent, because they are
 * the server's to decide. A client that sends them is ignored rather than
 * trusted — see DECISIONS.md D33.
 */
const money = z.coerce.number().int().nonnegative().max(2_000_000_000);

export const listingDraftSchema = z.object({
  title: z.string().trim().min(8, 'Give it a title of at least 8 characters').max(140),
  description: z.string().trim().min(30, 'Say a little more — 30 characters minimum').max(5_000),

  listingType: listingTypeSchema,
  propertyType: propertyTypeSchema,
  furnishing: furnishingTypeSchema,

  citySlug: z.string().min(1),
  address: z.string().trim().min(6).max(240),
  locality: z.string().trim().min(2).max(120),
  lat: latitudeSchema,
  lng: longitudeSchema,

  bedrooms: z.coerce.number().int().min(0).max(20),
  bathrooms: z.coerce.number().int().min(0).max(20),
  floor: z.coerce.number().int().min(-3).max(200).nullish(),
  totalFloors: z.coerce.number().int().min(0).max(200).nullish(),
  areaSqft: z.coerce.number().int().min(80).max(100_000),

  rentAmount: money.nullish(),
  salePrice: money.nullish(),
  securityDeposit: money.nullish(),
  maintenanceMonthly: money.nullish(),

  availableFrom: z.coerce.date().nullish(),
  rules: z.array(z.string().trim().min(2).max(120)).max(12).default([]),
  amenitySlugs: z.array(z.string().min(1)).max(40).default([]),
});

/**
 * A draft may be incomplete, but a listing that is going live must have the
 * price that matches its type and a floor that fits the building.
 */
export const publishableListingSchema = listingDraftSchema
  .refine(
    (listing) => (listing.listingType === 'RENT' ? typeof listing.rentAmount === 'number' : true),
    { message: 'A rental needs a monthly rent', path: ['rentAmount'] },
  )
  .refine(
    (listing) => (listing.listingType === 'SALE' ? typeof listing.salePrice === 'number' : true),
    { message: 'A property for sale needs a price', path: ['salePrice'] },
  )
  .refine(
    (listing) =>
      listing.floor == null || listing.totalFloors == null || listing.floor <= listing.totalFloors,
    { message: 'The floor cannot be above the top of the building', path: ['floor'] },
  );

export type ListingDraftInput = z.input<typeof listingDraftSchema>;
export type ListingDraft = z.infer<typeof listingDraftSchema>;

/**
 * What the wizard's FIRST step yields, and the whole of what it needs to open a
 * resumable draft.
 *
 * A pin, the city it resolves to, and whatever the reverse geocode was honest
 * enough to name. Nothing else: `listingDraftSchema` describes a complete
 * listing, and requiring a title before someone has placed a pin would mean the
 * wizard could not autosave its own first step. See DECISIONS.md D67.
 *
 * `address` and `locality` are optional here on purpose rather than by
 * omission — D59's rules say the street line stays empty and the locality is
 * prefilled only on a locality-level match.
 */
export const listingDraftStartSchema = z.object({
  citySlug: z.string().min(1),
  lat: latitudeSchema,
  lng: longitudeSchema,
  address: z.string().trim().max(240).optional(),
  locality: z.string().trim().max(120).optional(),
});

export type ListingDraftStartInput = z.input<typeof listingDraftStartSchema>;

/**
 * Every field optional: the wizard autosaves one step at a time.
 *
 * The text fields also accept `null`, which is how a step CLEARS one — the
 * partial's `undefined` means "not in this step" and cannot express "the user
 * emptied this box". Without the distinction, a title typed and then deleted
 * stays in the draft forever.
 */
export const listingPatchSchema = listingDraftSchema.partial().extend({
  title: listingDraftSchema.shape.title.nullish(),
  description: listingDraftSchema.shape.description.nullish(),
  address: listingDraftSchema.shape.address.nullish(),
  locality: listingDraftSchema.shape.locality.nullish(),
  propertyType: propertyTypeSchema.nullish(),
  furnishing: furnishingTypeSchema.nullish(),
  bedrooms: listingDraftSchema.shape.bedrooms.nullish(),
  bathrooms: listingDraftSchema.shape.bathrooms.nullish(),
  areaSqft: listingDraftSchema.shape.areaSqft.nullish(),
});
export type ListingPatchInput = z.input<typeof listingPatchSchema>;
export type ListingPatch = z.infer<typeof listingPatchSchema>;

/**
 * The fields a listing must have before it can go live, in the order the wizard
 * collects them, with the copy a lister should read when one is missing.
 *
 * Separate from `publishableListingSchema` because the two answer different
 * questions. This one answers "which step do I have to go back to", which is
 * what a half-finished draft needs; the schema answers "is this combination
 * coherent" — a rent on a sale, a third floor in a two-storey building — which
 * a complete draft can still fail.
 *
 * The same completeness rule is enforced by the `listing_complete_when_live`
 * CHECK constraint, so a row cannot reach PUBLISHED without it whatever any
 * service method forgets. This list exists to say WHICH field, in words.
 */
export const PUBLISH_REQUIRED_FIELDS = [
  { field: 'locality', step: 'location', message: 'Name the locality on the location step' },
  { field: 'address', step: 'location', message: 'Add the street address' },
  { field: 'propertyType', step: 'basics', message: 'Choose what kind of property this is' },
  { field: 'title', step: 'basics', message: 'Give the listing a title' },
  { field: 'description', step: 'basics', message: 'Describe the place' },
  { field: 'bedrooms', step: 'basics', message: 'Say how many bedrooms it has' },
  { field: 'bathrooms', step: 'basics', message: 'Say how many bathrooms it has' },
  { field: 'areaSqft', step: 'basics', message: 'Add the carpet area' },
  { field: 'furnishing', step: 'basics', message: 'Choose a furnishing level' },
] as const satisfies readonly { field: string; step: string; message: string }[];

export type PublishRequirement = (typeof PUBLISH_REQUIRED_FIELDS)[number];

/** Which required fields are still empty on a draft row. */
export function missingPublishFields(
  listing: Readonly<Record<string, unknown>>,
): PublishRequirement[] {
  return PUBLISH_REQUIRED_FIELDS.filter((requirement) => {
    const value = listing[requirement.field];
    return value === null || value === undefined || value === '';
  });
}

export const listingStatusActionSchema = z.enum(['publish', 'pause', 'unpause', 'mark-rented']);
export type ListingStatusAction = z.infer<typeof listingStatusActionSchema>;

// --- images ----------------------------------------------------------------

export const UPLOADABLE_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
] as const;
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 8_000;
export const MAX_IMAGES_PER_LISTING = 20;

export const imageUploadRequestSchema = z.object({
  contentType: z.enum(UPLOADABLE_IMAGE_TYPES),
  /** Advisory only — the real size is checked after upload. */
  byteSize: z.coerce.number().int().positive().max(MAX_IMAGE_BYTES),
});

export const imageUploadTicketSchema = z.object({
  imageId: z.string(),
  objectKey: z.string(),
  uploadUrl: z.string(),
  expiresInSeconds: z.number().int().positive(),
  /**
   * Form fields for a presigned POST. The client must send these, plus the file
   * last, as multipart/form-data — the storage service enforces the size and
   * type conditions baked into them.
   */
  fields: z.record(z.string(), z.string()),
});

export type ImageUploadTicket = z.infer<typeof imageUploadTicketSchema>;

export const listingImageSchema = z.object({
  id: z.string(),
  status: imageStatusSchema,
  width: z.number().int(),
  height: z.number().int(),
  sortOrder: z.number().int(),
  isCover: z.boolean(),
  /** Why a REJECTED or FAILED upload did not make it. Shown in the wizard. */
  failureReason: z.string().nullable(),
  /** Placeholder colour and inline preview, so a gallery never flashes empty. */
  dominantColor: z.string().nullable(),
  lqip: z.string().nullable(),
  /**
   * Public derivative URLs. Null until status is READY — the original lives in
   * a private prefix and is never served, so there is nothing to show before
   * the worker has validated and derived it.
   */
  urls: z
    .object({
      thumb: z.string(),
      card: z.string(),
      full: z.string(),
    })
    .nullable(),
});

export type ListingImageView = z.infer<typeof listingImageSchema>;

export const imageReorderSchema = z.object({
  /** Image ids in the order they should appear. The first becomes the cover. */
  imageIds: z.array(z.string().min(1)).min(1).max(MAX_IMAGES_PER_LISTING),
});

/**
 * A draft as the wizard reads it back.
 *
 * Every field the wizard collects, nullable, plus the images and the resolved
 * city — which is what makes the draft resumable on a different device: the
 * server holds the whole of it, and the client holds nothing that matters.
 */
export const listingDraftViewSchema = z.object({
  id: z.string(),
  slug: z.string(),
  status: listingStatusSchema,
  citySlug: z.string(),
  cityName: z.string(),

  lat: z.number(),
  lng: z.number(),
  address: z.string().nullable(),
  locality: z.string().nullable(),

  title: z.string().nullable(),
  description: z.string().nullable(),
  listingType: listingTypeSchema,
  propertyType: propertyTypeSchema.nullable(),
  furnishing: furnishingTypeSchema.nullable(),
  bedrooms: z.number().int().nullable(),
  bathrooms: z.number().int().nullable(),
  floor: z.number().int().nullable(),
  totalFloors: z.number().int().nullable(),
  areaSqft: z.number().int().nullable(),

  rentAmount: z.number().int().nullable(),
  salePrice: z.number().int().nullable(),
  securityDeposit: z.number().int().nullable(),
  maintenanceMonthly: z.number().int().nullable(),

  availableFrom: z.string().nullable(),
  rules: z.array(z.string()),
  amenitySlugs: z.array(z.string()),

  images: z.array(listingImageSchema),
  publishedAt: z.string().nullable(),
  updatedAt: z.string(),
});

export type ListingDraftView = z.infer<typeof listingDraftViewSchema>;

export const listingDraftResponseSchema = z.object({ draft: listingDraftViewSchema });
