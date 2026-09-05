import {
  amenityGroupsResponseSchema,
  amenitySchema,
  furnishingTypeSchema,
  imageUploadTicketSchema,
  listingDraftResponseSchema,
  listingImageSchema,
  listingStatusSchema,
  listingTypeSchema,
  propertyTypeSchema,
} from '@machiya/shared';
import { z } from 'zod';

export { amenityGroupsResponseSchema, listingDraftResponseSchema };

/**
 * The shape `GET /api/listings/:slug` actually returns.
 *
 * Declared here rather than in `@machiya/shared` because it is the *response*
 * of one endpoint assembled from a Prisma include, not a domain type both sides
 * own. Validating it at the boundary still matters: a change to that include
 * surfaces here as one clear parse error rather than as `undefined` inside a
 * component three levels down.
 */
export const listingDetailSchema = z.object({
  listing: z.object({
    id: z.string(),
    slug: z.string(),
    /**
     * Nullable because this endpoint also serves an owner their own DRAFT, and
     * a draft is genuinely incomplete until the wizard's later steps fill it
     * in. For anything PUBLISHED these are guaranteed non-null by the
     * `listing_complete_when_live` CHECK, not by hope — see DECISIONS.md D67.
     */
    title: z.string().nullable(),
    description: z.string().nullable(),
    listingType: listingTypeSchema,
    propertyType: propertyTypeSchema.nullable(),
    status: listingStatusSchema,
    furnishing: furnishingTypeSchema.nullable(),
    address: z.string().nullable(),
    locality: z.string().nullable(),
    lat: z.number(),
    lng: z.number(),
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
    isVerified: z.boolean(),
    viewCount: z.number().int(),
    rules: z.array(z.string()),
    publishedAt: z.string().nullable(),
    city: z.object({ slug: z.string(), name: z.string(), state: z.string() }),
    images: z.array(listingImageSchema),
    amenities: z.array(amenitySchema),
    owner: z.object({
      id: z.string(),
      name: z.string(),
      avatarUrl: z.string().nullable(),
      memberSince: z.string(),
      /**
       * Null until this reader has an open conversation with the owner. The
       * server decides; the client never receives a masked-but-present value.
       */
      phone: z.string().nullable(),
    }),
  }),
  viewerIsOwner: z.boolean(),
  viewerHasEnquired: z.boolean().default(false),
});

export type ListingDetail = z.infer<typeof listingDetailSchema>['listing'];

// --- the lister's own endpoints --------------------------------------------

export const createdListingSchema = z.object({
  listing: z.object({ id: z.string(), slug: z.string() }),
});

export const listingStatusResponseSchema = z.object({
  id: z.string(),
  status: listingStatusSchema,
  slug: z.string(),
  /** True on the publish that turned a seeker into a lister. */
  roleUpgraded: z.boolean(),
});

export const listingPatchedSchema = z.object({ id: z.string() });

export const imageTicketResponseSchema = z.object({ ticket: imageUploadTicketSchema });
export const imageUploadedResponseSchema = z.object({ image: listingImageSchema });
export const imageOrderResponseSchema = z.object({ images: z.array(listingImageSchema) });
export const imageDeletedSchema = z.object({ id: z.string() });
