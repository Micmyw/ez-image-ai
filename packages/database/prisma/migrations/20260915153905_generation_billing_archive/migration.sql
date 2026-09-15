-- AlterTable
ALTER TABLE "generation_job" ADD COLUMN     "archivedCreditsCharged" BIGINT,
ADD COLUMN     "archivedCreditsReleased" BIGINT;

ALTER TABLE "generation_job" ADD CONSTRAINT "generation_job_archived_billing_complete"
CHECK (
  ("archivedCreditsCharged" IS NULL AND "archivedCreditsReleased" IS NULL)
  OR ("archivedCreditsCharged" IS NOT NULL AND "archivedCreditsReleased" IS NOT NULL
    AND "status" IN ('SUCCEEDED', 'FAILED', 'CANCELED')
    AND "archivedCreditsCharged" >= 0 AND "archivedCreditsReleased" >= 0
    AND "archivedCreditsCharged" + "archivedCreditsReleased" = "creditsReserved")
);

CREATE FUNCTION "guard_generation_billing_archive"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."archivedCreditsCharged" IS NOT NULL OR NEW."archivedCreditsReleased" IS NOT NULL THEN
      RAISE EXCEPTION 'GENERATION_BILLING_ARCHIVE_REQUIRES_EXISTING_SETTLEMENT';
    END IF;
  ELSIF OLD."archivedCreditsCharged" IS NOT NULL THEN
    IF NEW."archivedCreditsCharged" IS DISTINCT FROM OLD."archivedCreditsCharged"
       OR NEW."archivedCreditsReleased" IS DISTINCT FROM OLD."archivedCreditsReleased" THEN
      RAISE EXCEPTION 'GENERATION_BILLING_ARCHIVE_IMMUTABLE';
    END IF;
  ELSIF NEW."archivedCreditsCharged" IS NOT NULL OR NEW."archivedCreditsReleased" IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.credit_reservation r WHERE r."jobId" = NEW.id
        AND r.status IN ('SETTLED', 'RELEASED')
        AND r."settledAmount" = NEW."archivedCreditsCharged"
        AND r."releasedAmount" = NEW."archivedCreditsReleased"
        AND r.amount = NEW."creditsReserved"
    ) THEN
      RAISE EXCEPTION 'GENERATION_BILLING_ARCHIVE_REQUIRES_EXISTING_SETTLEMENT';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION "guard_generation_billing_archive"() FROM PUBLIC;
CREATE TRIGGER "generation_job_archived_billing_immutable"
BEFORE INSERT OR UPDATE ON "generation_job"
FOR EACH ROW EXECUTE FUNCTION "guard_generation_billing_archive"();
