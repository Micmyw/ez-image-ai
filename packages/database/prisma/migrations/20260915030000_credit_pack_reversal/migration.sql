ALTER TABLE "credit_pack_adjustment" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'REFUND';
ALTER TABLE "credit_pack_adjustment" ADD CONSTRAINT "credit_pack_adjustment_kind_check" CHECK ("kind" IN ('REFUND', 'REVERSAL'));
