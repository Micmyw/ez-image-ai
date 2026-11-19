BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE public.portrait_pack_trial (
    "subjectKey" TEXT NOT NULL,
    "slot" INTEGER NOT NULL,
    "requestId" TEXT NOT NULL,
    "cardKeys" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT portrait_pack_trial_pkey PRIMARY KEY ("subjectKey", "slot"),
    CONSTRAINT portrait_pack_trial_slot_range CHECK ("slot" BETWEEN 1 AND 2),
    CONSTRAINT "portrait_pack_trial_subjectKey_requestId_key" UNIQUE ("subjectKey", "requestId")
);

ALTER TABLE public.portrait_pack_trial ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.portrait_pack_trial FROM PUBLIC;

DO $portrait_pack_private$
DECLARE api_role TEXT;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ezpic_app') THEN
        REVOKE ALL ON TABLE public.portrait_pack_trial FROM ezpic_app;
        GRANT SELECT, INSERT ON TABLE public.portrait_pack_trial TO ezpic_app;
        CREATE POLICY portrait_pack_trial_read ON public.portrait_pack_trial
            FOR SELECT TO ezpic_app USING (true);
        CREATE POLICY portrait_pack_trial_issue ON public.portrait_pack_trial
            FOR INSERT TO ezpic_app WITH CHECK (true);
    END IF;
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
            EXECUTE format('REVOKE ALL ON TABLE public.portrait_pack_trial FROM %I', api_role);
        END IF;
    END LOOP;
END;
$portrait_pack_private$;

COMMIT;
