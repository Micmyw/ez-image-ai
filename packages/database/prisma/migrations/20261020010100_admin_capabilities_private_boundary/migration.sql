BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
SET LOCAL idle_in_transaction_session_timeout = '45s';

-- Better Auth and management keys are authorized by the server. Supabase API
-- roles must never read credentials, execution results, refunds or tickets.
DO $admin_private$
DECLARE
    table_name TEXT;
    api_role TEXT;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'admin_service_account', 'admin_api_key', 'admin_execution',
        'admin_bot_config', 'admin_bot_receipt',
        'support_ticket', 'support_ticket_message', 'admin_refund_request'
    ] LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', table_name);

        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ezpic_app') THEN
            EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.%I TO ezpic_app', table_name);
            EXECUTE format(
                'CREATE POLICY %I ON public.%I TO ezpic_app USING (true) WITH CHECK (true)',
                table_name || '_app', table_name
            );
        END IF;

        FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
                EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', table_name, api_role);
            END IF;
        END LOOP;
    END LOOP;
END;
$admin_private$;

COMMIT;
