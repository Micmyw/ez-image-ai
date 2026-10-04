ALTER TABLE "media_asset" ADD COLUMN "videoCleanupCompletedAt" TIMESTAMPTZ(3);
CREATE INDEX "media_asset_video_provider_task_idx" ON "media_asset"("verificationEngine", "verificationProvider", "verificationProviderTaskId");
CREATE INDEX "media_asset_video_cleanup_idx" ON "media_asset"("verificationEngine", "videoCleanupCompletedAt", "createdAt", "id");
CREATE INDEX "provider_webhook_event_provider_status_receivedAt_idx" ON "provider_webhook_event"("provider", "status", "receivedAt");
