ALTER TABLE "credit_lot"
  ADD COLUMN "expiredUnrefundedAmount" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "credit_lot"
  DROP CONSTRAINT "credit_lot_amounts_valid",
  ADD CONSTRAINT "credit_lot_amounts_valid" CHECK (
    "grantedAmount" >= 0 AND "remainingAmount" >= 0 AND "reservedAmount" >= 0
    AND "expiredUnrefundedAmount" >= 0
    AND "remainingAmount" + "reservedAmount" + "expiredUnrefundedAmount" <= "grantedAmount"
  );
