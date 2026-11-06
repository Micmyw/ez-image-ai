-- Receiver-first: allow only the explicitly frozen source-template quote contract.
-- No old quote, request, model or financial snapshot is rewritten.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
SET LOCAL idle_in_transaction_session_timeout = '45s';

ALTER TABLE "generation_quote"
 DROP CONSTRAINT "generation_quote_moderation_decision_check",
 ADD CONSTRAINT "generation_quote_moderation_decision_check"
 CHECK ("moderationDecision" IN ('ALLOW', 'BYPASS', 'LEGACY_UNREVIEWED')
  OR ("moderationDecision" = 'PENDING_VIDEO_WORKFLOW'
   AND (
    "productKey" IN (
     'video-minimax-h3', 'video-seedance-2-5', 'video-seedance-2-mini',
     'video-seedance-1-pro-fast', 'video-seedance-1-5-pro', 'video-seedance-2',
     'video-seedance-2-fast', 'video-gemini-omni-flash', 'video-kling-3',
     'video-kling-3-turbo', 'video-kling-2-6-v1', 'video-veo-3-1', 'video-veo-3-1-fast'
    ) OR (
     "productKey" IN (
      'source-template:original-rap', 'source-template:rap-orange-studio',
      'source-template:rap-street-cypher', 'source-template:rap-neon-rap',
      'source-template:rap-funny-rap', 'source-template:bulin-47',
      'source-template:source-hotel-lobby', 'source-template:58th-floor',
      'source-template:green-booth-freestyle', 'source-template:spin-me-round',
      'source-template:kung-fu-cat', 'source-template:paws-at-you',
      'source-template:flying-car-curved-ramp-showcase', 'source-template:flying-car-curved-ramp',
      'source-template:flying-car-fleet-side', 'source-template:flying-car-fleet-front'
     )
     AND "catalogVersion" = 'ezrapvideo-source-2026-11-06.1'
     AND COALESCE("inputSnapshot"->>'requestKind', '') = 'source-template-video'
     AND COALESCE("inputSnapshot"->>'modelContractVersion', '') = 'ezrapvideo-source-2026-11-06.1'
     AND "productKey" = 'source-template:' || COALESCE("inputSnapshot"#>>'{sourceTemplate,templateKey}', '')
    )
   )
   AND "moderationProvider" = 'video-workflow-v1'
   AND "moderationReasonCode" = 'PENDING_VIDEO_WORKFLOW'
   AND "inputFingerprint" ~ '^[a-f0-9]{64}$'));

COMMIT;
