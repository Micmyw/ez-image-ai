-- AlterTable
ALTER TABLE "payment_checkout_intent" ADD COLUMN     "attribution" JSONB;

-- AlterTable
ALTER TABLE "purchase" ADD COLUMN     "attribution" JSONB;

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "registrationAttribution" JSONB;
