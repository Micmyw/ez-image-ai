-- Extend the pending-Workflow quote boundary to the implemented public catalog.
-- Keep this explicit allowlist fail-closed; catalog-driven PostgreSQL tests detect
-- future implemented models that require a corresponding forward migration.
-- One ALTER statement replaces the check atomically without rewriting any rows.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
SET LOCAL idle_in_transaction_session_timeout = '45s';

ALTER TABLE "generation_quote"
 DROP CONSTRAINT "generation_quote_moderation_decision_check",
 ADD CONSTRAINT "generation_quote_moderation_decision_check"
 CHECK ("moderationDecision" IN ('ALLOW', 'BYPASS', 'LEGACY_UNREVIEWED')
  OR ("moderationDecision" = 'PENDING_VIDEO_WORKFLOW'
   AND "productKey" IN (
    'video-minimax-h3',
    'video-seedance-2-5',
    'video-seedance-2-mini',
    'video-seedance-1-pro-fast',
    'video-seedance-1-5-pro',
    'video-seedance-2',
    'video-seedance-2-fast',
    'video-gemini-omni-flash',
    'video-kling-3',
    'video-kling-3-turbo',
    'video-kling-2-6-v1',
    'video-veo-3-1'
   )
   AND "moderationProvider" = 'video-workflow-v1'
   AND "moderationReasonCode" = 'PENDING_VIDEO_WORKFLOW'
   AND "inputFingerprint" ~ '^[a-f0-9]{64}$'));

COMMIT;
