import {
  furnishingTypeSchema,
  listingImageSchema,
  listingStatusSchema,
  listingTypeSchema,
  propertyTypeSchema,
} from '@machiya/shared';
import { z } from 'zod';

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
    title: z.string(),
    description: z.string(),
    listingType: listingTypeSchema,
    propertyType: propertyTypeSchema,
    status: listingStatusSchema,
    furnishing: furnishingTypeSchema,
    address: z.string(),
    locality: z.string(),
    lat: z.number(),
    lng: z.number(),
    bedrooms: z.number().int(),
    bathrooms: z.number().int(),
    floor: z.number().int().nullable(),
    totalFloors: z.number().int().nullable(),
    areaSqft: z.number().int(),
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
    amenities: z.array(
      z.object({
        id: z.string(),
        slug: z.string(),
        name: z.string(),
        icon: z.string().nullable(),
        category: z.string(),
      }),
    ),
    owner: z.object({
      id: z.string(),
      name: z.string(),
      avatarUrl: z.string().nullable(),
      memberSince: z.string(),
      /** Masked until an enquiry is sent. */
      phone: z.string().nullable(),
    }),
  }),
  viewerIsOwner: z.boolean(),
});

export type ListingDetail = z.infer<typeof listingDetailSchema>['listing'];
