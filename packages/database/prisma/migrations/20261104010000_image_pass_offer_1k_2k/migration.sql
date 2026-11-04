-- Accept the 2026-11-04.1 Image Pass offer (1K/2K sizes only) alongside the
-- original 2026-10-19.1 offer. Widening only: every existing row still passes,
-- and unsettled 2026-10-19.1 intents keep fulfilling with their frozen snapshot.
ALTER TABLE "payment_checkout_intent" DROP CONSTRAINT "payment_checkout_intent_image_pass_snapshot";
ALTER TABLE "payment_checkout_intent" ADD CONSTRAINT "payment_checkout_intent_image_pass_snapshot" CHECK (COALESCE((
  ("productKind"::text <> 'IMAGE_PASS' AND "imagePassOfferSnapshot" IS NULL)
  OR ("productKind"::text = 'IMAGE_PASS' AND "provider" = 'paypal' AND "ownerType" = 'USER'
      AND "ownerId" = "submittedByUserId" AND "interval" = 'one-time'
      AND jsonb_typeof("imagePassOfferSnapshot") = 'object'
      AND "imagePassOfferSnapshot"->>'offerKey' = 'image-pass-3'
      AND "imagePassOfferSnapshot"->>'offerVersion' IN ('2026-10-19.1', '2026-11-04.1')
      AND "imagePassOfferSnapshot"->>'provider' = 'paypal'
      AND "imagePassOfferSnapshot"->>'amount' = '1.00'
      AND "imagePassOfferSnapshot"->>'currency' = 'USD'
      AND "imagePassOfferSnapshot"->>'units' = '3'
      AND jsonb_typeof("imagePassOfferSnapshot"->'allowedSkuKeys') = 'array')
), FALSE));
