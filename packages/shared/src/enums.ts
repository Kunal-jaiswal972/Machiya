import { z } from 'zod';

/**
 * Zod mirrors of the native Postgres enums in packages/db/prisma/schema.prisma.
 *
 * These are the single source of truth for validation, imported by both web and
 * api. packages/db carries a compile-time guard (src/enum-guard.ts) that fails
 * the build if any of these ever drifts from the generated Prisma enum, so the
 * duplication cannot rot silently.
 */

export const userRoleSchema = z.enum(['SEEKER', 'LISTER', 'ADMIN']);
export const listingTypeSchema = z.enum(['RENT', 'SALE']);
export const listingStatusSchema = z.enum(['DRAFT', 'PUBLISHED', 'PAUSED', 'RENTED']);
export const furnishingTypeSchema = z.enum(['UNFURNISHED', 'SEMI_FURNISHED', 'FULLY_FURNISHED']);
export const propertyTypeSchema = z.enum([
  'APARTMENT',
  'INDEPENDENT_HOUSE',
  'BUILDER_FLOOR',
  'VILLA',
  'STUDIO',
  'PENTHOUSE',
  'PG',
]);
export const enquiryStatusSchema = z.enum(['OPEN', 'RESPONDED', 'CLOSED', 'SPAM']);
export const fuelTypeSchema = z.enum(['PETROL', 'DIESEL', 'CNG']);
export const imageStatusSchema = z.enum(['PENDING', 'READY', 'REJECTED', 'FAILED']);

export type UserRole = z.infer<typeof userRoleSchema>;
export type ListingType = z.infer<typeof listingTypeSchema>;
export type ListingStatus = z.infer<typeof listingStatusSchema>;
export type FurnishingType = z.infer<typeof furnishingTypeSchema>;
export type PropertyType = z.infer<typeof propertyTypeSchema>;
export type EnquiryStatus = z.infer<typeof enquiryStatusSchema>;
export type FuelType = z.infer<typeof fuelTypeSchema>;
export type ImageStatus = z.infer<typeof imageStatusSchema>;

/**
 * The value arrays, for anything that has to RENDER every option — a filter
 * chip row, a wizard select, a legend. Derived from the schemas rather than
 * written twice, so adding a variant reaches the UI without a second edit.
 */
export const USER_ROLES = userRoleSchema.options;
export const LISTING_TYPES = listingTypeSchema.options;
export const LISTING_STATUSES = listingStatusSchema.options;
export const FURNISHING_TYPES = furnishingTypeSchema.options;
export const PROPERTY_TYPES = propertyTypeSchema.options;
export const ENQUIRY_STATUSES = enquiryStatusSchema.options;
export const FUEL_TYPES = fuelTypeSchema.options;
export const IMAGE_STATUSES = imageStatusSchema.options;
