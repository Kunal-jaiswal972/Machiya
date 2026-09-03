import { z } from 'zod';
import {
  furnishingTypeSchema,
  imageStatusSchema,
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

/** Every field optional: the wizard autosaves one step at a time. */
export const listingPatchSchema = listingDraftSchema.partial();
export type ListingPatchInput = z.input<typeof listingPatchSchema>;

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
