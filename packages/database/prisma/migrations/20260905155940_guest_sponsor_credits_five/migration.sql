-- AlterTable
ALTER TABLE "guest_media_trial" DROP CONSTRAINT "guest_media_trial_sponsor_credits_check";

ALTER TABLE "guest_media_trial" ALTER COLUMN "sponsorCredits" SET DEFAULT 5;

ALTER TABLE "guest_media_trial"
ADD CONSTRAINT "guest_media_trial_sponsor_credits_check" CHECK ("sponsorCredits" IN (4, 5));
