-- Do not infer an environment for historical verified events. Unknown records
-- require explicit isolation before the same database can accept live payments.
ALTER TABLE "payment_event" ADD COLUMN "providerEnvironment" TEXT;
