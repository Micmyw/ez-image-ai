ALTER TABLE "generation_quote"
ADD COLUMN "moderationDecision" TEXT NOT NULL DEFAULT 'LEGACY_UNREVIEWED',
ADD COLUMN "moderationProvider" TEXT NOT NULL DEFAULT 'legacy',
ADD COLUMN "moderationRuleVersion" TEXT NOT NULL DEFAULT 'legacy',
ADD COLUMN "moderationReasonCode" TEXT NOT NULL DEFAULT 'LEGACY_UNREVIEWED',
ADD COLUMN "inputFingerprint" TEXT NOT NULL DEFAULT '';

ALTER TABLE "generation_quote"
ADD CONSTRAINT "generation_quote_moderation_decision_check"
CHECK ("moderationDecision" IN ('ALLOW', 'LEGACY_UNREVIEWED')),
ADD CONSTRAINT "generation_quote_approved_fingerprint_check"
CHECK (
  "moderationDecision" <> 'ALLOW'
  OR "inputFingerprint" ~ '^[a-f0-9]{64}$'
);

CREATE OR REPLACE FUNCTION prevent_generation_quote_security_update() RETURNS trigger AS $$
BEGIN
  IF NEW."ownerType" IS DISTINCT FROM OLD."ownerType"
    OR NEW."ownerId" IS DISTINCT FROM OLD."ownerId"
    OR NEW."submittedByUserId" IS DISTINCT FROM OLD."submittedByUserId"
    OR NEW."productKey" IS DISTINCT FROM OLD."productKey"
    OR NEW."catalogVersion" IS DISTINCT FROM OLD."catalogVersion"
    OR NEW."pricingVersion" IS DISTINCT FROM OLD."pricingVersion"
    OR NEW."credits" IS DISTINCT FROM OLD."credits"
    OR NEW."costMicros" IS DISTINCT FROM OLD."costMicros"
    OR NEW."inputSnapshot" IS DISTINCT FROM OLD."inputSnapshot"
    OR NEW."pricingSnapshot" IS DISTINCT FROM OLD."pricingSnapshot"
    OR NEW."moderationDecision" IS DISTINCT FROM OLD."moderationDecision"
    OR NEW."moderationProvider" IS DISTINCT FROM OLD."moderationProvider"
    OR NEW."moderationRuleVersion" IS DISTINCT FROM OLD."moderationRuleVersion"
    OR NEW."moderationReasonCode" IS DISTINCT FROM OLD."moderationReasonCode"
    OR NEW."inputFingerprint" IS DISTINCT FROM OLD."inputFingerprint"
    OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
  THEN
    RAISE EXCEPTION 'generation_quote security fields are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER generation_quote_security_immutable
BEFORE UPDATE ON "generation_quote"
FOR EACH ROW EXECUTE FUNCTION prevent_generation_quote_security_update();
