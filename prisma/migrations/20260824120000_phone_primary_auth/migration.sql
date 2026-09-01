-- Make phoneNumber the primary login credential; drop email + Google identity.

-- 1. Backfill any missing phone numbers so the NOT NULL + UNIQUE constraints
--    below can be applied without dropping existing accounts. The row id is
--    globally unique, so it is a safe placeholder; affected users must set a
--    real phone number before they can log in again.
UPDATE "users" SET "phoneNumber" = "id" WHERE "phoneNumber" IS NULL;

-- 2. Enforce the new invariant.
ALTER TABLE "users" ALTER COLUMN "phoneNumber" SET NOT NULL;
CREATE UNIQUE INDEX "users_phoneNumber_key" ON "users"("phoneNumber");

-- 3. Drop the email + Google identity that phone-based auth replaces.
DROP INDEX "users_email_key";
DROP INDEX "users_googleId_key";
ALTER TABLE "users" DROP COLUMN "email";
ALTER TABLE "users" DROP COLUMN "googleId";
