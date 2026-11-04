-- Add the USD 2.99 / three-image offer without rewriting historical USD 1 terms.
-- Deploy compatible consumers and producers before provisioning the new BillingPlan.
BEGIN;

ALTER TABLE "payment_checkout_intent" DROP CONSTRAINT "payment_checkout_intent_image_pass_snapshot";
ALTER TABLE "payment_checkout_intent" ADD CONSTRAINT "payment_checkout_intent_image_pass_snapshot" CHECK (COALESCE((
  ("productKind"::text <> 'IMAGE_PASS' AND "imagePassOfferSnapshot" IS NULL)
  OR ("productKind"::text = 'IMAGE_PASS' AND "provider" = 'paypal' AND "ownerType" = 'USER'
      AND "ownerId" = "submittedByUserId" AND "interval" = 'one-time'
      AND jsonb_typeof("imagePassOfferSnapshot") = 'object'
      AND "imagePassOfferSnapshot"->>'offerKey' = 'image-pass-3'
      AND "imagePassOfferSnapshot"->>'provider' = 'paypal'
      AND "imagePassOfferSnapshot"->>'currency' = 'USD'
      AND "imagePassOfferSnapshot"->>'units' = '3'
      AND jsonb_typeof("imagePassOfferSnapshot"->'allowedSkuKeys') = 'array'
      AND (
        ("imagePassOfferSnapshot"->>'offerVersion' IN ('2026-10-19.1', '2026-11-04.1')
          AND "imagePassOfferSnapshot"->>'amount' = '1.00'
          AND NOT ("imagePassOfferSnapshot" ? 'subscriptionPolicy'))
        OR ("imagePassOfferSnapshot"->>'offerVersion' = '2026-11-04.2'
          AND "imagePassOfferSnapshot"->>'amount' = '2.99'
          AND "imagePassOfferSnapshot"->>'subscriptionPolicy' = 'not-required')
      ))
), FALSE));

ALTER TABLE "image_pass_grant" DROP CONSTRAINT "image_pass_grant_paidAmountMicros_check";
ALTER TABLE "image_pass_grant" ADD CONSTRAINT "image_pass_grant_paid_offer_check" CHECK (COALESCE(
  jsonb_typeof("offerSnapshot") = 'object'
  AND "offerSnapshot"->>'offerKey' = 'image-pass-3'
  AND "offerSnapshot"->>'provider' = 'paypal'
  AND "offerSnapshot"->>'currency' = 'USD'
  AND "offerSnapshot"->>'units' = '3'
  AND jsonb_typeof("offerSnapshot"->'allowedSkuKeys') = 'array'
  AND (
    ("paidAmountMicros" = 1000000
      AND "offerSnapshot"->>'offerVersion' IN ('2026-10-19.1', '2026-11-04.1')
      AND "offerSnapshot"->>'amount' = '1.00'
      AND NOT ("offerSnapshot" ? 'subscriptionPolicy'))
    OR ("paidAmountMicros" = 2990000
      AND "offerSnapshot"->>'offerVersion' = '2026-11-04.2'
      AND "offerSnapshot"->>'amount' = '2.99'
      AND "offerSnapshot"->>'subscriptionPolicy' = 'not-required')
  ), FALSE));

ALTER TABLE "image_pass_adjustment" DROP CONSTRAINT "image_pass_adjustment_amountMicros_check";
ALTER TABLE "image_pass_adjustment" ADD CONSTRAINT "image_pass_adjustment_amountMicros_check"
  CHECK ("amountMicros" > 0 AND "amountMicros" <= 2990000);

-- A higher current retail price must not raise the refund/dispute ceiling for old purchases.
CREATE FUNCTION "assert_image_pass_adjustment_amount"() RETURNS TRIGGER LANGUAGE plpgsql
SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "image_pass_grant" g WHERE g."id"=NEW."grantId"
    AND g."provider"=NEW."provider" AND g."currency"=NEW."currency"
    AND NEW."amountMicros" > 0 AND NEW."amountMicros" <= g."paidAmountMicros") THEN
    RAISE EXCEPTION 'IMAGE_PASS_ADJUSTMENT_INVALID';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "image_pass_adjustment_paid_amount" BEFORE INSERT ON "image_pass_adjustment"
FOR EACH ROW EXECUTE FUNCTION "assert_image_pass_adjustment_amount"();
REVOKE ALL ON FUNCTION "assert_image_pass_adjustment_amount"() FROM PUBLIC;

COMMIT;
