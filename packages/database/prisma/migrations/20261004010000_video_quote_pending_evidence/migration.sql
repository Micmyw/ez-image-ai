-- A video quote freezes price and input; actual moderation runs in its owning Workflow.
-- Preserve all old decisions and their existing ALLOW/BYPASS fingerprint constraints.
ALTER TABLE "generation_quote" DROP CONSTRAINT "generation_quote_moderation_decision_check";
ALTER TABLE "generation_quote" ADD CONSTRAINT "generation_quote_moderation_decision_check"
 CHECK ("moderationDecision" IN ('ALLOW', 'BYPASS', 'LEGACY_UNREVIEWED')
  OR ("moderationDecision" = 'PENDING_VIDEO_WORKFLOW'
   AND "productKey" = 'video-kling-2-6-v1'
   AND "moderationProvider" = 'video-workflow-v1'
   AND "moderationReasonCode" = 'PENDING_VIDEO_WORKFLOW'
   AND "inputFingerprint" ~ '^[a-f0-9]{64}$'));
