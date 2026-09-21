-- DropIndex
DROP INDEX "guest_media_trial_ownerId_promotionPeriod_key";

-- DropIndex
DROP INDEX "guest_media_trial_promotionPeriod_deviceHash_key";

-- DropIndex
DROP INDEX "guest_media_trial_promotionPeriod_sourceSessionHash_key";

-- DropIndex
DROP INDEX "guest_session_bootstrap_ownerId_promotionPeriod_key";

-- CreateIndex
CREATE INDEX "guest_media_trial_ownerId_promotionPeriod_createdAt_idx" ON "guest_media_trial"("ownerId", "promotionPeriod", "createdAt");

-- CreateIndex
CREATE INDEX "guest_media_trial_session_daily_idx" ON "guest_media_trial"("promotionPeriod", "sourceSessionHash", "createdAt");

-- CreateIndex
CREATE INDEX "guest_media_trial_device_daily_idx" ON "guest_media_trial"("promotionPeriod", "deviceHash", "createdAt");

-- CreateIndex
CREATE INDEX "guest_session_bootstrap_ownerId_promotionPeriod_createdAt_idx" ON "guest_session_bootstrap"("ownerId", "promotionPeriod", "createdAt");
