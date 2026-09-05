-- Soft deletion for accounts: the row stays, its personal fields are scrubbed.
-- Nullable and unindexed on purpose — nothing queries by it, it is read with
-- the user. See DECISIONS.md D80.
ALTER TABLE "User" ADD COLUMN "deletedAt" TIMESTAMP(3);
