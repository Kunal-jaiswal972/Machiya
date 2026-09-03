-- Hand-edited. Prisma's generated version added a NOT NULL column with no
-- default to a populated table, which cannot run. The value is derivable for
-- every existing row — it is exactly what the old code computed at each call
-- site — so it is backfilled in place and only then constrained.
--
-- See DECISIONS.md D41 for why this moved from a computed key to a stored one.

-- AlterTable
ALTER TABLE "ListingImage" ADD COLUMN "variantBaseKey" TEXT;

UPDATE "ListingImage"
   SET "variantBaseKey" = 'variants/' || "listingId" || '/' || "id"
 WHERE "variantBaseKey" IS NULL;

ALTER TABLE "ListingImage" ALTER COLUMN "variantBaseKey" SET NOT NULL;
