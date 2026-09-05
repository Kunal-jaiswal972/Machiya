-- A draft listing is genuinely incomplete, so the columns the wizard fills on
-- its later steps become nullable — and the completeness rule moves to a CHECK
-- that fires the moment the listing stops being a draft.
--
-- See DECISIONS.md D67 for why this beats writing placeholder values, and D59
-- for why `address` in particular has to be allowed to stay empty.

ALTER TABLE "Listing"
  ALTER COLUMN "title" DROP NOT NULL,
  ALTER COLUMN "description" DROP NOT NULL,
  ALTER COLUMN "address" DROP NOT NULL,
  ALTER COLUMN "locality" DROP NOT NULL,
  ALTER COLUMN "propertyType" DROP NOT NULL,
  ALTER COLUMN "furnishing" DROP NOT NULL,
  ALTER COLUMN "bedrooms" DROP NOT NULL,
  ALTER COLUMN "bathrooms" DROP NOT NULL,
  ALTER COLUMN "areaSqft" DROP NOT NULL;

-- `listingType` is defaulted rather than nullable: a two-value enum has no
-- honest null, and this is a rentals product first.
ALTER TABLE "Listing"
  ALTER COLUMN "listingType" SET DEFAULT 'RENT';

-- The invariant the nullability gives up, restored where it cannot be skipped.
--
-- Prisma has no CHECK support, so it ignores this and reports no drift — the
-- same arrangement as `listing_location_present` (D15) and
-- `city_boundary_has_area` (D50). Without it, "a PUBLISHED listing is complete"
-- would be a rule enforced only by the one service method that publishes, and
-- a seed, a psql fix or a future bulk import could each break it quietly.
--
-- The price clause is here rather than only in `publishableListingSchema`
-- because a live rental with no rent is not a validation failure, it is a row
-- that makes every price sort and every total-cost sort wrong.
ALTER TABLE "Listing" DROP CONSTRAINT IF EXISTS listing_complete_when_live;

ALTER TABLE "Listing"
  ADD CONSTRAINT listing_complete_when_live CHECK (
    "status" = 'DRAFT'
    OR (
      "title" IS NOT NULL
      AND "description" IS NOT NULL
      AND "address" IS NOT NULL
      AND "locality" IS NOT NULL
      AND "propertyType" IS NOT NULL
      AND "furnishing" IS NOT NULL
      AND "bedrooms" IS NOT NULL
      AND "bathrooms" IS NOT NULL
      AND "areaSqft" IS NOT NULL
      AND (
        ("listingType" = 'RENT' AND "rentAmount" IS NOT NULL)
        OR ("listingType" = 'SALE' AND "salePrice" IS NOT NULL)
      )
    )
  );
