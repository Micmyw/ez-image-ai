BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
SET LOCAL idle_in_transaction_session_timeout = '45s';

-- Permanent issuance receipts are private and append-only to the application.
ALTER TABLE public.guest_trial_entitlement ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.guest_trial_entitlement FROM PUBLIC;

DO $guest_entitlement_private$
DECLARE api_role TEXT;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ezpic_app') THEN
        REVOKE ALL ON TABLE public.guest_trial_entitlement FROM ezpic_app;
        GRANT SELECT, INSERT ON TABLE public.guest_trial_entitlement TO ezpic_app;
        CREATE POLICY guest_trial_entitlement_read ON public.guest_trial_entitlement
            FOR SELECT TO ezpic_app USING (true);
        CREATE POLICY guest_trial_entitlement_issue ON public.guest_trial_entitlement
            FOR INSERT TO ezpic_app WITH CHECK (true);
    END IF;
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
            EXECUTE format('REVOKE ALL ON TABLE public.guest_trial_entitlement FROM %I', api_role);
        END IF;
    END LOOP;
END;
$guest_entitlement_private$;
COMMIT;
