-- PREPARED ONLY. Production execution requires separate approval of target and rollback.
-- Apply reviewed image-pass migration first. This adds a one-time merchant SKU,
-- never a subscription and never ordinary credits. No remote PayPal API is called.
BEGIN;
INSERT INTO "billing_plan" ("id","provider","providerPriceId","productKind","name","creditsPerPeriod","priceMicros","currency","active","version","metadata","updatedAt")
VALUES ('image-pass-3-paypal-20261019','paypal','EZIMAGE-IMAGE-PASS-3-USD-1-20261019','IMAGE_PASS','image-pass-3',0,1000000,'USD',TRUE,1,'{"providerEnvironment":"live","imagePassOfferSnapshot":{"offerKey":"image-pass-3","offerVersion":"2026-10-19.1","provider":"paypal","amount":"1.00","currency":"USD","units":3,"allowedSkuKeys":["nano-banana-2-lite-1k","nano-banana-default","nano-banana-2-1k","nano-banana-2-2k","nano-banana-2-4k","nano-banana-pro-1k","nano-banana-pro-2k","nano-banana-pro-4k","gpt-image-1-5-medium","gpt-image-1-5-high","gpt-image-2-1k","gpt-image-2-2k","gpt-image-2-4k","gpt-image-2-5-flare-1k","gpt-image-2-5-flare-2k","gpt-image-2-5-flare-4k","gpt-image-2-5-sunburst-1k","gpt-image-2-5-sunburst-2k","gpt-image-2-5-sunburst-4k","seedream-4-1k","seedream-4-2k","seedream-4-4k","seedream-4-5-basic-2k","seedream-4-5-high-4k","seedream-5-lite-basic-2k","seedream-5-lite-high-3k","seedream-5-lite-ultra-4k","seedream-5-pro-basic-1k","seedream-5-pro-high-2k"]}}'::jsonb,CURRENT_TIMESTAMP)
ON CONFLICT ("provider","providerPriceId") DO NOTHING;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM "billing_plan" WHERE "provider"='paypal' AND "providerPriceId"='EZIMAGE-IMAGE-PASS-3-USD-1-20261019'
   AND "productKind"::text='IMAGE_PASS' AND "name"='image-pass-3' AND "creditsPerPeriod"=0 AND "priceMicros"=1000000 AND "currency"='USD'
   AND "active" AND "metadata"='{"providerEnvironment":"live","imagePassOfferSnapshot":{"offerKey":"image-pass-3","offerVersion":"2026-10-19.1","provider":"paypal","amount":"1.00","currency":"USD","units":3,"allowedSkuKeys":["nano-banana-2-lite-1k","nano-banana-default","nano-banana-2-1k","nano-banana-2-2k","nano-banana-2-4k","nano-banana-pro-1k","nano-banana-pro-2k","nano-banana-pro-4k","gpt-image-1-5-medium","gpt-image-1-5-high","gpt-image-2-1k","gpt-image-2-2k","gpt-image-2-4k","gpt-image-2-5-flare-1k","gpt-image-2-5-flare-2k","gpt-image-2-5-flare-4k","gpt-image-2-5-sunburst-1k","gpt-image-2-5-sunburst-2k","gpt-image-2-5-sunburst-4k","seedream-4-1k","seedream-4-2k","seedream-4-4k","seedream-4-5-basic-2k","seedream-4-5-high-4k","seedream-5-lite-basic-2k","seedream-5-lite-high-3k","seedream-5-lite-ultra-4k","seedream-5-pro-basic-1k","seedream-5-pro-high-2k"]}}'::jsonb) THEN
  RAISE EXCEPTION 'IMAGE_PASS_EXISTING_PLAN_DIFFERS_REVIEW_REQUIRED';
 END IF;
END; $$;
COMMIT;
