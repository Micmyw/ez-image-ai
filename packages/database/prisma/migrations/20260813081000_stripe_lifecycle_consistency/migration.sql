ALTER TYPE "BillingPeriodStatus" ADD VALUE 'REFUNDED';

ALTER TABLE "subscription" ADD COLUMN "graceEndsAt" TIMESTAMPTZ(3);

-- Annual invoice monetary snapshots are copied to each period. Refund bounds are enforced
-- by the serialized invoice-group processor rather than per repeated period row.
ALTER TABLE "billing_period" DROP CONSTRAINT "billing_period_refunds_bounded";
ALTER TABLE "billing_period" ADD CONSTRAINT "billing_period_refunds_nonnegative"
  CHECK ("paidAmount" >= 0 AND "refundedAmount" >= 0 AND "refundedCredits" >= 0
    AND "refundedCredits" <= "creditAmount");
