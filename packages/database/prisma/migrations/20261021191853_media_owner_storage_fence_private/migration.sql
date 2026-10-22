BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
SET LOCAL idle_in_transaction_session_timeout = '45s';

-- Storage fences are a server-only concurrency primitive. A browser role must
-- never read owner activity or alter the row that protects quota admission.
ALTER TABLE public.media_owner_storage_fence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.media_owner_storage_fence FROM PUBLIC;

DO $storage_fence_private$
DECLARE
    api_role TEXT;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ezpic_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.media_owner_storage_fence TO ezpic_app;
        CREATE POLICY media_owner_storage_fence_app ON public.media_owner_storage_fence
            TO ezpic_app USING (true) WITH CHECK (true);
    END IF;

    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
            EXECUTE format('REVOKE ALL ON TABLE public.media_owner_storage_fence FROM %I', api_role);
        END IF;
    END LOOP;
END;
$storage_fence_private$;

COMMIT;
