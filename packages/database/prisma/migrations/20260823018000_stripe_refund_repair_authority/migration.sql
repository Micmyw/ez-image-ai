CREATE TYPE "StripeRefundRepairAction" AS ENUM (
  'CONFIRM_SUCCEEDED',
  'COMPENSATE_FAILED_OR_CANCELED'
);

CREATE TABLE "stripe_refund_repair_authority" (
  "id" TEXT NOT NULL,
  "approvalKey" TEXT NOT NULL,
  "refundId" TEXT NOT NULL,
  "issueId" TEXT NOT NULL,
  "action" "StripeRefundRepairAction" NOT NULL,
  "lifecycleStatus" "StripeRefundStatus" NOT NULL,
  "lifecycleLastProviderChangeId" TEXT NOT NULL,
  "lifecycleLastProviderChangeAt" TIMESTAMPTZ(3) NOT NULL,
  "approvedCredits" BIGINT NOT NULL,
  "ledgerFingerprint" TEXT NOT NULL,
  "approvedByUserId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stripe_refund_repair_authority_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stripe_refund_repair_authority_credits_positive" CHECK ("approvedCredits" > 0),
  CONSTRAINT "stripe_refund_repair_authority_reason_present" CHECK (length(btrim("reason")) >= 10),
  CONSTRAINT "stripe_refund_repair_authority_action_matches_status" CHECK (
    ("action" = 'CONFIRM_SUCCEEDED' AND "lifecycleStatus" = 'SUCCEEDED')
    OR
    (
      "action" = 'COMPENSATE_FAILED_OR_CANCELED'
      AND "lifecycleStatus" IN ('FAILED', 'CANCELED')
    )
  )
);

CREATE TABLE "stripe_refund_repair_receipt" (
  "id" TEXT NOT NULL,
  "authorityId" TEXT NOT NULL,
  "operationKey" TEXT NOT NULL,
  "appliedByUserId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "compensatedCredits" BIGINT NOT NULL DEFAULT 0,
  "appliedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stripe_refund_repair_receipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stripe_refund_repair_receipt_reason_present" CHECK (length(btrim("reason")) >= 10),
  CONSTRAINT "stripe_refund_repair_receipt_credits_nonnegative" CHECK ("compensatedCredits" >= 0)
);

CREATE UNIQUE INDEX "stripe_refund_repair_authority_approvalKey_key"
  ON "stripe_refund_repair_authority"("approvalKey");
CREATE UNIQUE INDEX "stripe_refund_repair_authority_refund_snapshot_key"
  ON "stripe_refund_repair_authority"(
    "refundId",
    "lifecycleLastProviderChangeId",
    "ledgerFingerprint"
  );
CREATE INDEX "stripe_refund_repair_authority_issueId_createdAt_idx"
  ON "stripe_refund_repair_authority"("issueId", "createdAt");
CREATE UNIQUE INDEX "stripe_refund_repair_receipt_authorityId_key"
  ON "stripe_refund_repair_receipt"("authorityId");
CREATE UNIQUE INDEX "stripe_refund_repair_receipt_operationKey_key"
  ON "stripe_refund_repair_receipt"("operationKey");

ALTER TABLE "stripe_refund_repair_authority"
  ADD CONSTRAINT "stripe_refund_repair_authority_refundId_fkey"
  FOREIGN KEY ("refundId") REFERENCES "stripe_refund"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stripe_refund_repair_authority"
  ADD CONSTRAINT "stripe_refund_repair_authority_issueId_fkey"
  FOREIGN KEY ("issueId") REFERENCES "stripe_reconciliation_issue"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stripe_refund_repair_receipt"
  ADD CONSTRAINT "stripe_refund_repair_receipt_authorityId_fkey"
  FOREIGN KEY ("authorityId") REFERENCES "stripe_refund_repair_authority"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "reject_stripe_refund_repair_authority_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'stripe refund repair authority is immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "stripe_refund_repair_authority_immutable"
BEFORE UPDATE OR DELETE ON "stripe_refund_repair_authority"
FOR EACH ROW EXECUTE FUNCTION "reject_stripe_refund_repair_authority_mutation"();

CREATE FUNCTION "reject_stripe_refund_repair_receipt_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'stripe refund repair receipt is immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "stripe_refund_repair_receipt_immutable"
BEFORE UPDATE OR DELETE ON "stripe_refund_repair_receipt"
FOR EACH ROW EXECUTE FUNCTION "reject_stripe_refund_repair_receipt_mutation"();
