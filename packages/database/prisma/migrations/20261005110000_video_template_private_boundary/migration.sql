BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
SET LOCAL idle_in_transaction_session_timeout = '45s';

-- Template state and provider identities are server-only. Better Auth users do
-- not receive direct Supabase table access; the existing database owner runs it.
ALTER TABLE "video_template_execution" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "video_template_execution" FROM PUBLIC;

ALTER FUNCTION public.guard_video_template_identity()
 SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.guard_video_template_output_binding()
 SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.guard_video_template_sealed_asset()
 SET search_path = pg_catalog, public, pg_temp;
REVOKE ALL ON FUNCTION public.guard_video_template_identity() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_video_template_output_binding() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_video_template_sealed_asset() FROM PUBLIC;

DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
  REVOKE ALL ON TABLE "video_template_execution" FROM anon;
  REVOKE ALL ON FUNCTION public.guard_video_template_identity() FROM anon;
  REVOKE ALL ON FUNCTION public.guard_video_template_output_binding() FROM anon;
  REVOKE ALL ON FUNCTION public.guard_video_template_sealed_asset() FROM anon;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
  REVOKE ALL ON TABLE "video_template_execution" FROM authenticated;
  REVOKE ALL ON FUNCTION public.guard_video_template_identity() FROM authenticated;
  REVOKE ALL ON FUNCTION public.guard_video_template_output_binding() FROM authenticated;
  REVOKE ALL ON FUNCTION public.guard_video_template_sealed_asset() FROM authenticated;
 END IF;
END $$;

COMMIT;
