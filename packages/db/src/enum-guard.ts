import type {
  EnquiryStatus as SharedEnquiryStatus,
  FuelType as SharedFuelType,
  FurnishingType as SharedFurnishingType,
  ListingStatus as SharedListingStatus,
  ListingType as SharedListingType,
  PropertyType as SharedPropertyType,
  UserRole as SharedUserRole,
} from '@machiya/shared';
import type {
  EnquiryStatus,
  FuelType,
  FurnishingType,
  ListingStatus,
  ListingType,
  PropertyType,
  UserRole,
} from '../generated/prisma/enums.js';

/**
 * Compile-time proof that the Zod enums in @machiya/shared and the native
 * Postgres enums in schema.prisma are the same set of values.
 *
 * The Zod schemas cannot be derived from the Prisma types directly — that would
 * make @machiya/shared depend on @machiya/db, which already depends on shared.
 * So the values are written once in shared and pinned here: add a variant to
 * one side only and `pnpm typecheck` fails on this file. See DECISIONS.md D14.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

// Each line must evaluate to `true`. A mismatch resolves to `never` and errors.
const _userRole: Exact<UserRole, SharedUserRole> = true;
const _listingType: Exact<ListingType, SharedListingType> = true;
const _listingStatus: Exact<ListingStatus, SharedListingStatus> = true;
const _furnishing: Exact<FurnishingType, SharedFurnishingType> = true;
const _propertyType: Exact<PropertyType, SharedPropertyType> = true;
const _enquiryStatus: Exact<EnquiryStatus, SharedEnquiryStatus> = true;
const _fuelType: Exact<FuelType, SharedFuelType> = true;

void _userRole;
void _listingType;
void _listingStatus;
void _furnishing;
void _propertyType;
void _enquiryStatus;
void _fuelType;
