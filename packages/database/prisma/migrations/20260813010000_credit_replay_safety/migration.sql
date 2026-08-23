-- Persist reservation revocations so refunds cannot be resurrected by later release.
ALTER TABLE "credit_reservation_allocation"
  ADD COLUMN "revokedAmount" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "revokedSettledAmount" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "revokedReleasedAmount" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "credit_reservation_allocation"
  ADD CONSTRAINT "credit_allocation_revocation_amounts_valid" CHECK (
    "revokedAmount" >= 0
    AND "revokedAmount" <= "amount"
    AND "revokedSettledAmount" >= 0
    AND "revokedReleasedAmount" >= 0
    AND "revokedSettledAmount" <= "settledAmount"
    AND "revokedReleasedAmount" <= "releasedAmount"
    AND "revokedSettledAmount" + "revokedReleasedAmount" <= "revokedAmount"
  );

-- Every lease acquisition gets a new capability token; acknowledgements compare it atomically.
ALTER TABLE "outbox_event" ADD COLUMN "leaseToken" TEXT;
CREATE UNIQUE INDEX "outbox_event_leaseToken_key" ON "outbox_event"("leaseToken");
