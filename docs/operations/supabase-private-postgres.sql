-- Platform hardening for the EzPic-owned tables on a dedicated Supabase project.
-- Run after Prisma migrate deploy. Prisma remains the domain migration authority.
-- The backend connects as the table owner; Supabase browser roles have no access.
REVOKE ALL ON SCHEMA public FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE ezpic_app IN SCHEMA public
    REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE ezpic_app IN SCHEMA public
    REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE ezpic_app IN SCHEMA public
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;

DO $$
DECLARE relation record;
BEGIN
    FOR relation IN
        SELECT schemaname, tablename
        FROM pg_tables
        WHERE schemaname = 'public' AND tableowner = 'ezpic_app'
    LOOP
        EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', relation.schemaname, relation.tablename);
        EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM anon, authenticated', relation.schemaname, relation.tablename);
    END LOOP;
END;
$$;

-- These existing trigger functions resolve only builtins and EzPic public tables.
-- Keep pg_temp last so callers cannot shadow the domain tables through temp tables.
ALTER FUNCTION public.reject_credit_ledger_mutation() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.prevent_generation_quote_security_update() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.media_upload_session_require_staging_key() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.media_upload_session_guard_finalization_lease() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.prevent_asset_moderation_evidence_mutation() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.prevent_ready_media_asset_identity_mutation() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.enforce_media_asset_ready_evidence() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.reject_stripe_refund_repair_authority_mutation() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.reject_stripe_refund_repair_receipt_mutation() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.media_upload_session_guard_staged_terminalization() SET search_path = pg_catalog, public, pg_temp;
