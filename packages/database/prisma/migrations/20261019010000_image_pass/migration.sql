-- Review/apply only this additive delta through the approved production process.
-- Do not run full migration history or mark Prisma history without verification.
BEGIN;
ALTER TYPE "PaymentProductKind" ADD VALUE IF NOT EXISTS 'IMAGE_PASS';
ALTER TABLE "payment_checkout_intent" ADD COLUMN "imagePassOfferSnapshot" JSONB;
ALTER TABLE "generation_job" ADD COLUMN "fundingSource" TEXT NOT NULL DEFAULT 'CREDITS';
ALTER TABLE "generation_job" DROP CONSTRAINT "generation_job_credits_reserved_positive";
ALTER TABLE "generation_job" ADD CONSTRAINT "generation_job_funding_amount_valid" CHECK (
  ("fundingSource" = 'CREDITS' AND "creditsReserved" > 0)
  OR ("fundingSource" = 'IMAGE_PASS' AND "creditsReserved" = 0 AND "ownerType" = 'USER'
      AND "productKey" LIKE 'image-%' AND "executionEngine" = 'legacy')
);
ALTER TABLE "payment_checkout_intent" DROP CONSTRAINT "payment_checkout_intent_credit_pack_snapshot";
ALTER TABLE "payment_checkout_intent" ADD CONSTRAINT "payment_checkout_intent_credit_pack_snapshot" CHECK (
    (
        "productKind"::text IN ('PLAN', 'IMAGE_PASS')
        AND "creditPackCatalogVersion" IS NULL
        AND "creditPackPricingVersion" IS NULL
        AND "creditPackSubscriberEligibilityVersion" IS NULL
        AND "creditPackBaseCredits" IS NULL
        AND "creditPackBonusCredits" IS NULL
        AND "creditPackTotalCredits" IS NULL
        AND "creditPackExpiryMonths" IS NULL
        AND "creditPackSubscriberBonusEligible" IS NULL
        AND "creditPackSubscriberSubscriptionId" IS NULL
        AND "creditPackSubscriberPlanKey" IS NULL
        AND "creditPackEligibilityEvaluatedAt" IS NULL
    ) OR (
        "productKind" = 'CREDIT_PACK'
        AND "provider" IN ('paypal', 'waffo')
        AND "interval" = 'one-time'
        AND NULLIF("creditPackCatalogVersion", '') IS NOT NULL
        AND NULLIF("creditPackPricingVersion", '') IS NOT NULL
        AND NULLIF("creditPackSubscriberEligibilityVersion", '') IS NOT NULL
        AND "creditPackBaseCredits" > 0
        AND "creditPackBonusCredits" >= 0
        AND "creditPackTotalCredits" = "creditPackBaseCredits" + "creditPackBonusCredits"
        AND "creditPackExpiryMonths" = 6
        AND "creditPackSubscriberBonusEligible" IS NOT NULL
        AND "creditPackEligibilityEvaluatedAt" IS NOT NULL
        AND (
            (
                "creditPackSubscriberBonusEligible" = FALSE
                AND "creditPackBonusCredits" = 0
                AND "creditPackSubscriberSubscriptionId" IS NULL
                AND "creditPackSubscriberPlanKey" IS NULL
            ) OR (
                "creditPackSubscriberBonusEligible" = TRUE
                AND "creditPackBonusCredits" > 0
                AND NULLIF("creditPackSubscriberSubscriptionId", '') IS NOT NULL
                AND NULLIF("creditPackSubscriberPlanKey", '') IS NOT NULL
            )
        )
    )
);
ALTER TABLE "payment_checkout_intent" ADD CONSTRAINT "payment_checkout_intent_image_pass_snapshot" CHECK (COALESCE((
  ("productKind"::text <> 'IMAGE_PASS' AND "imagePassOfferSnapshot" IS NULL)
  OR ("productKind"::text = 'IMAGE_PASS' AND "provider" = 'paypal' AND "ownerType" = 'USER'
      AND "ownerId" = "submittedByUserId" AND "interval" = 'one-time'
      AND jsonb_typeof("imagePassOfferSnapshot") = 'object'
      AND "imagePassOfferSnapshot"->>'offerKey' = 'image-pass-3'
      AND "imagePassOfferSnapshot"->>'offerVersion' = '2026-10-19.1'
      AND "imagePassOfferSnapshot"->>'provider' = 'paypal'
      AND "imagePassOfferSnapshot"->>'amount' = '1.00'
      AND "imagePassOfferSnapshot"->>'currency' = 'USD'
      AND "imagePassOfferSnapshot"->>'units' = '3'
      AND jsonb_typeof("imagePassOfferSnapshot"->'allowedSkuKeys') = 'array')
), FALSE));

CREATE TABLE "image_pass_grant" (
 "id" TEXT PRIMARY KEY,
 "checkoutIntentId" TEXT NOT NULL UNIQUE REFERENCES "payment_checkout_intent"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "purchaseId" TEXT UNIQUE REFERENCES "purchase"("id") ON DELETE SET NULL ON UPDATE CASCADE,
 "ownerId" TEXT NOT NULL,
 "provider" TEXT NOT NULL CHECK ("provider" = 'paypal'),
 "providerOrderId" TEXT NOT NULL,
 "providerPaymentId" TEXT NOT NULL,
 "paidAmountMicros" BIGINT NOT NULL CHECK ("paidAmountMicros" = 1000000),
 "currency" TEXT NOT NULL CHECK ("currency" = 'USD'),
 "offerSnapshot" JSONB NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'ACTIVE' CHECK ("status" IN ('ACTIVE','FROZEN')),
 "paidAt" TIMESTAMPTZ(3) NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE ("provider", "providerPaymentId"), UNIQUE ("provider", "providerOrderId")
);
CREATE INDEX "image_pass_grant_ownerId_status_createdAt_id_idx" ON "image_pass_grant"("ownerId","status","createdAt","id");
CREATE TABLE "image_pass_unit" (
 "id" TEXT PRIMARY KEY,
 "grantId" TEXT NOT NULL REFERENCES "image_pass_grant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "ordinal" INTEGER NOT NULL CHECK ("ordinal" BETWEEN 1 AND 3),
 "status" TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK ("status" IN ('AVAILABLE','RESERVED','CONSUMED','REVOKED')),
 UNIQUE ("grantId", "ordinal")
);
CREATE INDEX "image_pass_unit_grantId_status_ordinal_idx" ON "image_pass_unit"("grantId","status","ordinal");
CREATE TABLE "image_pass_reservation" (
 "id" TEXT PRIMARY KEY,
 "unitId" TEXT NOT NULL REFERENCES "image_pass_unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "jobId" TEXT NOT NULL UNIQUE REFERENCES "generation_job"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "ownerId" TEXT NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'ACTIVE' CHECK ("status" IN ('ACTIVE','SETTLED','RELEASED')),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "finalizedAt" TIMESTAMPTZ(3),
 CHECK (("status" = 'ACTIVE' AND "finalizedAt" IS NULL) OR ("status" <> 'ACTIVE' AND "finalizedAt" IS NOT NULL))
);
CREATE UNIQUE INDEX "image_pass_reservation_one_active_unit" ON "image_pass_reservation"("unitId") WHERE "status" = 'ACTIVE';
CREATE INDEX "image_pass_reservation_unitId_status_idx" ON "image_pass_reservation"("unitId","status");
CREATE INDEX "image_pass_reservation_ownerId_status_idx" ON "image_pass_reservation"("ownerId","status");
CREATE TABLE "image_pass_ledger_entry" (
 "id" TEXT PRIMARY KEY,
 "grantId" TEXT NOT NULL REFERENCES "image_pass_grant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "unitId" TEXT REFERENCES "image_pass_unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "jobId" TEXT,
 "operation" TEXT NOT NULL CHECK ("operation" IN ('GRANT','RESERVE','CONSUME','RELEASE','REVOKE','FREEZE')),
 "referenceKey" TEXT NOT NULL UNIQUE,
 "metadata" JSONB NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "image_pass_ledger_entry_grantId_createdAt_id_idx" ON "image_pass_ledger_entry"("grantId","createdAt","id");
CREATE INDEX "image_pass_ledger_entry_jobId_operation_idx" ON "image_pass_ledger_entry"("jobId","operation");
CREATE TABLE "image_pass_adjustment" (
 "id" TEXT PRIMARY KEY,
 "grantId" TEXT NOT NULL REFERENCES "image_pass_grant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "provider" TEXT NOT NULL CHECK ("provider" = 'paypal'),
 "providerAdjustmentId" TEXT NOT NULL,
 "kind" TEXT NOT NULL CHECK ("kind" IN ('REFUND','DISPUTE')),
 "amountMicros" BIGINT NOT NULL CHECK ("amountMicros" > 0 AND "amountMicros" <= 1000000),
 "currency" TEXT NOT NULL CHECK ("currency" = 'USD'),
 "occurredAt" TIMESTAMPTZ(3) NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE ("provider", "providerAdjustmentId")
);
CREATE FUNCTION "prevent_image_pass_ledger_mutation"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'IMAGE_PASS_LEDGER_IMMUTABLE'; END; $$;
CREATE TRIGGER "image_pass_ledger_immutable" BEFORE UPDATE OR DELETE ON "image_pass_ledger_entry"
FOR EACH ROW EXECUTE FUNCTION "prevent_image_pass_ledger_mutation"();
CREATE FUNCTION "assert_image_pass_funding_binding"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE j RECORD; u RECORD;
BEGIN
 IF TG_TABLE_NAME = 'generation_job' THEN
  IF NEW."fundingSource" <> OLD."fundingSource" OR NEW."creditsReserved" <> OLD."creditsReserved" THEN
   RAISE EXCEPTION 'GENERATION_FUNDING_IMMUTABLE';
  END IF;
 ELSIF TG_TABLE_NAME = 'credit_reservation' THEN
  SELECT "fundingSource" INTO j FROM "generation_job" WHERE "id" = NEW."jobId";
  IF j."fundingSource" <> 'CREDITS' THEN RAISE EXCEPTION 'GENERATION_FUNDING_CONFLICT'; END IF;
 ELSE
  SELECT "ownerId", "fundingSource", "creditsReserved" INTO j FROM "generation_job" WHERE "id" = NEW."jobId";
  SELECT g."ownerId" INTO u FROM "image_pass_unit" unit JOIN "image_pass_grant" g ON g."id"=unit."grantId" WHERE unit."id"=NEW."unitId";
  IF j."fundingSource" <> 'IMAGE_PASS' OR j."creditsReserved" <> 0 OR j."ownerId" <> NEW."ownerId" OR u."ownerId" <> NEW."ownerId" THEN
   RAISE EXCEPTION 'GENERATION_FUNDING_CONFLICT';
  END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER "generation_funding_immutable" BEFORE UPDATE OF "fundingSource", "creditsReserved" ON "generation_job"
FOR EACH ROW EXECUTE FUNCTION "assert_image_pass_funding_binding"();
CREATE TRIGGER "credit_reservation_funding_binding" BEFORE INSERT OR UPDATE OF "jobId" ON "credit_reservation"
FOR EACH ROW EXECUTE FUNCTION "assert_image_pass_funding_binding"();
CREATE TRIGGER "image_pass_reservation_funding_binding" BEFORE INSERT OR UPDATE OF "jobId","unitId","ownerId" ON "image_pass_reservation"
FOR EACH ROW EXECUTE FUNCTION "assert_image_pass_funding_binding"();

-- Keep paid identity, unit identity and reservation binding immutable.
CREATE FUNCTION "guard_image_pass_identity"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'IMAGE_PASS_IDENTITY_IMMUTABLE'; END IF;
 IF TG_TABLE_NAME = 'image_pass_grant' THEN
  IF (to_jsonb(NEW) - 'status' - 'purchaseId') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'purchaseId')
    OR (NEW."purchaseId" IS DISTINCT FROM OLD."purchaseId" AND NOT (OLD."purchaseId" IS NOT NULL AND NEW."purchaseId" IS NULL))
    OR (OLD."status" = 'FROZEN' AND NEW."status" <> 'FROZEN') THEN
   RAISE EXCEPTION 'IMAGE_PASS_IDENTITY_IMMUTABLE';
  END IF;
 ELSIF TG_TABLE_NAME = 'image_pass_unit' THEN
  IF NEW."id" <> OLD."id" OR NEW."grantId" <> OLD."grantId" OR NEW."ordinal" <> OLD."ordinal"
    OR (OLD."status" IN ('CONSUMED','REVOKED') AND NEW."status" <> OLD."status")
    OR (OLD."status" = 'AVAILABLE' AND NEW."status" NOT IN ('AVAILABLE','RESERVED','REVOKED'))
    OR (OLD."status" = 'RESERVED' AND NEW."status" NOT IN ('RESERVED','AVAILABLE','CONSUMED','REVOKED')) THEN
   RAISE EXCEPTION 'IMAGE_PASS_IDENTITY_IMMUTABLE';
  END IF;
 ELSE
  IF (to_jsonb(NEW) - 'status' - 'finalizedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'finalizedAt')
    OR (OLD."status" <> 'ACTIVE' AND NEW."status" <> OLD."status") THEN
   RAISE EXCEPTION 'IMAGE_PASS_IDENTITY_IMMUTABLE';
  END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER "image_pass_grant_identity" BEFORE UPDATE OR DELETE ON "image_pass_grant" FOR EACH ROW EXECUTE FUNCTION "guard_image_pass_identity"();
CREATE TRIGGER "image_pass_unit_identity" BEFORE UPDATE OR DELETE ON "image_pass_unit" FOR EACH ROW EXECUTE FUNCTION "guard_image_pass_identity"();
CREATE TRIGGER "image_pass_reservation_identity" BEFORE UPDATE OR DELETE ON "image_pass_reservation" FOR EACH ROW EXECUTE FUNCTION "guard_image_pass_identity"();
CREATE TRIGGER "image_pass_adjustment_immutable" BEFORE UPDATE OR DELETE ON "image_pass_adjustment" FOR EACH ROW EXECUTE FUNCTION "prevent_image_pass_ledger_mutation"();

CREATE FUNCTION "assert_image_pass_three_units"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE grant_id TEXT;
BEGIN
 IF TG_TABLE_NAME = 'image_pass_grant' THEN grant_id := NEW."id"; ELSE grant_id := NEW."grantId"; END IF;
 IF (SELECT COUNT(*) FROM "image_pass_unit" WHERE "grantId"=grant_id) <> 3 THEN
  RAISE EXCEPTION 'IMAGE_PASS_REQUIRES_EXACTLY_THREE_UNITS';
 END IF;
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER "image_pass_grant_three_units" AFTER INSERT ON "image_pass_grant"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assert_image_pass_three_units"();
CREATE CONSTRAINT TRIGGER "image_pass_unit_three_units" AFTER INSERT ON "image_pass_unit"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assert_image_pass_three_units"();

-- Better Auth identities are server-owned, not Supabase auth.uid(). Match the
-- existing private operational tables: direct application SQL only, no Data API.
ALTER TABLE "image_pass_grant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "image_pass_unit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "image_pass_reservation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "image_pass_ledger_entry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "image_pass_adjustment" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "image_pass_grant", "image_pass_unit", "image_pass_reservation", "image_pass_ledger_entry", "image_pass_adjustment" FROM PUBLIC;
DO $$
DECLARE table_name TEXT; browser_role TEXT;
BEGIN
 FOREACH table_name IN ARRAY ARRAY['image_pass_grant','image_pass_unit','image_pass_reservation','image_pass_ledger_entry','image_pass_adjustment'] LOOP
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ezpic_app') THEN
   EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE %I TO ezpic_app',table_name);
   EXECUTE format('CREATE POLICY %I ON %I TO ezpic_app USING (true) WITH CHECK (true)',table_name || '_app',table_name);
  END IF;
  FOREACH browser_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=browser_role) THEN
    EXECUTE format('REVOKE ALL ON TABLE %I FROM %I',table_name,browser_role);
   END IF;
  END LOOP;
 END LOOP;
 FOREACH browser_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=browser_role) THEN
   EXECUTE format('REVOKE ALL ON FUNCTION public.prevent_image_pass_ledger_mutation(),public.assert_image_pass_funding_binding(),public.guard_image_pass_identity(),public.assert_image_pass_three_units() FROM %I',browser_role);
  END IF;
 END LOOP;
END $$;
ALTER FUNCTION "prevent_image_pass_ledger_mutation"() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION "assert_image_pass_funding_binding"() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION "guard_image_pass_identity"() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION "assert_image_pass_three_units"() SET search_path=pg_catalog,public,pg_temp;
REVOKE ALL ON FUNCTION "prevent_image_pass_ledger_mutation"(), "assert_image_pass_funding_binding"(), "guard_image_pass_identity"(), "assert_image_pass_three_units"() FROM PUBLIC;

COMMIT;
