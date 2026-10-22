BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
SET LOCAL idle_in_transaction_session_timeout = '45s';

-- CreateTable
CREATE TABLE "media_workflow_phase_owner" (
    "phaseKey" TEXT NOT NULL,
    "phaseKind" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "workflowId" TEXT NOT NULL,
    "epoch" INTEGER NOT NULL DEFAULT 1,
    "leasedUntil" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "media_workflow_phase_owner_pkey" PRIMARY KEY ("phaseKey")
);

-- CreateIndex
CREATE INDEX "media_workflow_phase_owner_leasedUntil_idx" ON "media_workflow_phase_owner"("leasedUntil");

-- CreateIndex
CREATE UNIQUE INDEX "media_workflow_phase_owner_phaseKind_subjectId_generation_key" ON "media_workflow_phase_owner"("phaseKind", "subjectId", "generation");

-- Phase ownership is a server-only execution fence. Browser roles cannot read
-- workflow identities or change the epoch that protects a paid provider call.
ALTER TABLE public.media_workflow_phase_owner ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.media_workflow_phase_owner FROM PUBLIC;

DO $workflow_phase_owner_private$
DECLARE
    api_role TEXT;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ezpic_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.media_workflow_phase_owner TO ezpic_app;
        CREATE POLICY media_workflow_phase_owner_app ON public.media_workflow_phase_owner
            TO ezpic_app USING (true) WITH CHECK (true);
    END IF;

    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
            EXECUTE format('REVOKE ALL ON TABLE public.media_workflow_phase_owner FROM %I', api_role);
        END IF;
    END LOOP;
END;
$workflow_phase_owner_private$;

COMMIT;
