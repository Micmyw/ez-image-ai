-- Run against the verified production target only after compatible jobs and website deployments.
-- Idempotent local merchant SKU provision; calls no PayPal API and rewrites no old plan or grant.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
INSERT INTO "billing_plan" ("id","provider","providerPriceId","productKind","name","creditsPerPeriod","priceMicros","currency","active","version","metadata","updatedAt")
VALUES ('image-pass-3-paypal-299-20261104','paypal','EZIMAGE-IMAGE-PASS-3-USD-299-20261104','IMAGE_PASS','image-pass-3',0,2990000,'USD',TRUE,1,'{"providerEnvironment":"live","imagePassOfferSnapshot":{"offerKey":"image-pass-3","offerVersion":"2026-11-04.2","provider":"paypal","amount":"2.99","currency":"USD","units":3,"subscriptionPolicy":"not-required","allowedSkuKeys":["nano-banana-2-lite-1k","nano-banana-default","nano-banana-2-1k","nano-banana-2-2k","nano-banana-2-4k","nano-banana-pro-1k","nano-banana-pro-2k","nano-banana-pro-4k","gpt-image-1-5-medium","gpt-image-1-5-high","gpt-image-2-1k","gpt-image-2-2k","gpt-image-2-4k","gpt-image-2-5-flare-1k","gpt-image-2-5-flare-2k","gpt-image-2-5-flare-4k","gpt-image-2-5-sunburst-1k","gpt-image-2-5-sunburst-2k","gpt-image-2-5-sunburst-4k","seedream-4-1k","seedream-4-2k","seedream-4-4k","seedream-4-5-basic-2k","seedream-4-5-high-4k","seedream-5-lite-basic-2k","seedream-5-lite-high-3k","seedream-5-lite-ultra-4k","seedream-5-pro-basic-1k","seedream-5-pro-high-2k"]}}'::jsonb,CURRENT_TIMESTAMP)
ON CONFLICT ("provider","providerPriceId") DO NOTHING;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM "billing_plan" WHERE "provider"='paypal' AND "providerPriceId"='EZIMAGE-IMAGE-PASS-3-USD-299-20261104'
   AND "productKind"::text='IMAGE_PASS' AND "name"='image-pass-3' AND "creditsPerPeriod"=0 AND "priceMicros"=2990000 AND "currency"='USD'
   AND "active" AND "metadata"='{"providerEnvironment":"live","imagePassOfferSnapshot":{"offerKey":"image-pass-3","offerVersion":"2026-11-04.2","provider":"paypal","amount":"2.99","currency":"USD","units":3,"subscriptionPolicy":"not-required","allowedSkuKeys":["nano-banana-2-lite-1k","nano-banana-default","nano-banana-2-1k","nano-banana-2-2k","nano-banana-2-4k","nano-banana-pro-1k","nano-banana-pro-2k","nano-banana-pro-4k","gpt-image-1-5-medium","gpt-image-1-5-high","gpt-image-2-1k","gpt-image-2-2k","gpt-image-2-4k","gpt-image-2-5-flare-1k","gpt-image-2-5-flare-2k","gpt-image-2-5-flare-4k","gpt-image-2-5-sunburst-1k","gpt-image-2-5-sunburst-2k","gpt-image-2-5-sunburst-4k","seedream-4-1k","seedream-4-2k","seedream-4-4k","seedream-4-5-basic-2k","seedream-4-5-high-4k","seedream-5-lite-basic-2k","seedream-5-lite-high-3k","seedream-5-lite-ultra-4k","seedream-5-pro-basic-1k","seedream-5-pro-high-2k"]}}'::jsonb) THEN
  RAISE EXCEPTION 'IMAGE_PASS_EXISTING_PLAN_DIFFERS_REVIEW_REQUIRED';
 END IF;
END; $$;
COMMIT;
