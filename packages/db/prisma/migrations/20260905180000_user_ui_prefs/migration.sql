-- Map style and tour completion, per user rather than per browser.
ALTER TABLE "User" ADD COLUMN "uiPrefs" JSONB;
