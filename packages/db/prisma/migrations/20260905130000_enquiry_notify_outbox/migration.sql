-- The enquiry notification's record of intent.
--
-- Same shape as the image pipeline's PENDING row (D40): the message row is the
-- outbox, the mail is enqueued strictly after the commit, and a reconciler
-- drains what the enqueue missed. See DECISIONS.md D68 for why a lost enquiry
-- notification is worth reconciling when a lost image job was too.

ALTER TABLE "EnquiryMessage"
  ADD COLUMN "notifyOwed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "notifiedAt" TIMESTAMP(3),
  ADD COLUMN "notifyFails" INTEGER NOT NULL DEFAULT 0;

-- Existing seeded messages predate the notification and are not owed one; the
-- default already says so, and this is here to make that explicit rather than
-- leaving a reader to work it out from the DEFAULT clause.
UPDATE "EnquiryMessage" SET "notifyOwed" = false WHERE "notifiedAt" IS NULL;

CREATE INDEX "EnquiryMessage_notifyOwed_notifiedAt_createdAt_idx"
  ON "EnquiryMessage" ("notifyOwed", "notifiedAt", "createdAt");
