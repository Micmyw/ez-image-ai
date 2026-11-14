BEGIN;
ALTER TABLE public.media_output_origin ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.media_output_origin FROM PUBLIC;
DO $origin_private$
DECLARE api_role TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ezpic_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.media_output_origin TO ezpic_app;
    CREATE POLICY media_output_origin_app ON public.media_output_origin FOR ALL TO ezpic_app USING (true) WITH CHECK (true);
  END IF;
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.media_output_origin FROM %I', api_role);
    END IF;
  END LOOP;
END;
$origin_private$;
COMMIT;
