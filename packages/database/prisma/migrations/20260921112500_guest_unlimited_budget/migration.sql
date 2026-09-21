-- AlterTable
ALTER TABLE "guest_risk_budget_bucket" ALTER COLUMN "hardLimitMicros" DROP NOT NULL;

-- Prisma does not model check constraints. Keep finite budgets enforced while
-- giving NULL its explicit unlimited meaning; nonnegative accounting is unchanged.
ALTER TABLE "guest_risk_budget_bucket"
  DROP CONSTRAINT "guest_risk_budget_limit_check",
  ADD CONSTRAINT "guest_risk_budget_limit_check" CHECK (
    "hardLimitMicros" IS NULL OR
    ("hardLimitMicros" > 0 AND "reservedMicros" + "consumedMicros" <= "hardLimitMicros")
  );
