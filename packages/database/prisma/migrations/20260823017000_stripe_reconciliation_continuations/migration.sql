ALTER TABLE "stripe_reconciliation_checkpoint"
  ADD COLUMN "continuationSequence" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "stripe_reconciliation_continuation_sequence_nonnegative"
    CHECK ("continuationSequence" >= 0);
