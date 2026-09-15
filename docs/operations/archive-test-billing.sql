-- Reviewed operational cutover, never an automatic application migration.
-- Run as the database administrator in one transaction after stopping admission
-- and draining the old executor. The caller must set LOCAL ezpic.cutover_manifest
-- to the reviewed backup/fingerprint/catalog manifest. See payment-production-cutover.md.
DO $cutover$
DECLARE
  manifest jsonb := current_setting('ezpic.cutover_manifest')::jsonb;
  archive_name text := manifest->>'archiveSchema';
  names text[] := ARRAY[
    'billing_period','billing_plan','credit_account','credit_ledger_entry','credit_lot',
    'credit_pack_adjustment','credit_pack_fulfillment','credit_reservation',
    'credit_reservation_allocation','outbox_event','payment_checkout_intent',
    'payment_checkout_intent_idempotency_alias','payment_customer','payment_event',
    'payment_reconciliation_checkpoint','purchase','stripe_reconciliation_checkpoint',
    'stripe_reconciliation_issue','stripe_refund','stripe_refund_receipt',
    'stripe_refund_repair_authority','stripe_refund_repair_receipt','subscription',
    'subscription_payment_adjustment'
  ];
  item record;
  actual jsonb;
  source_count bigint;
  plans jsonb := manifest->'plans';
BEGIN
  IF current_user <> 'postgres' OR manifest->>'database' IS DISTINCT FROM current_database()
    OR NOT COALESCE(archive_name ~ '^billing_test_[0-9]{8}$',false)
    OR manifest->>'admissionAndExecutorDrained' IS DISTINCT FROM 'true'
    OR manifest->'backup'->>'restoreVerified' IS DISTINCT FROM 'true'
    OR NOT COALESCE(manifest->'backup'->>'sha256' ~ '^[a-f0-9]{64}$',false)
    OR jsonb_typeof(manifest->'expected') IS DISTINCT FROM 'object'
    OR jsonb_typeof(plans) IS DISTINCT FROM 'array'
  THEN RAISE EXCEPTION 'BILLING_ARCHIVE_REVIEW_REQUIRED'; END IF;
  IF to_regnamespace(archive_name) IS NOT NULL THEN
    RAISE EXCEPTION 'BILLING_ARCHIVE_ALREADY_EXISTS';
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(manifest->'expected')) <> cardinality(names)
    OR NOT (manifest->'expected' ?& names) THEN
    RAISE EXCEPTION 'BILLING_ARCHIVE_TABLE_SET_MISMATCH';
  END IF;
  IF jsonb_array_length(plans) <> 20
    OR (SELECT count(DISTINCT (p->>'provider', p->>'providerPriceId')) FROM jsonb_array_elements(plans) p) <> 20
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(plans) p WHERE
      NOT COALESCE(((p->>'provider' = 'paypal' AND p->'metadata'->>'providerEnvironment' = 'live')
        OR (p->>'provider' = 'waffo' AND p->'metadata'->>'providerEnvironment' = 'prod')),false)
      OR p->>'currency' IS DISTINCT FROM 'USD'
      OR COALESCE((p->>'priceMicros')::bigint,0) <= 0 OR COALESCE((p->>'creditsPerPeriod')::bigint,0) <= 0)
  THEN RAISE EXCEPTION 'BILLING_ARCHIVE_LIVE_CATALOG_REQUIRED'; END IF;

  -- Lock the small, reviewed application dataset. A changed dataset aborts below.
  FOR item IN SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename LOOP
    EXECUTE format('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE', item.tablename);
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.payment_event WHERE "providerEnvironment" IN ('live','prod'))
    OR EXISTS (SELECT 1 FROM public.billing_plan WHERE metadata->>'providerEnvironment' IN ('live','prod'))
    OR EXISTS (SELECT 1 FROM public.generation_job WHERE status NOT IN ('SUCCEEDED','FAILED','CANCELED'))
    OR EXISTS (SELECT 1 FROM public.credit_reservation WHERE status='ACTIVE')
    OR EXISTS (SELECT 1 FROM public.credit_account WHERE "reservedCredits" <> 0)
    OR EXISTS (SELECT 1 FROM public.storage_usage_reservation WHERE status='ACTIVE')
    OR EXISTS (SELECT 1 FROM public.generation_attempt WHERE "uncertainSubmission"
      OR status NOT IN ('SUCCEEDED','FAILED','CANCELED'))
    OR EXISTS (SELECT 1 FROM public.media_upload_session WHERE status IN ('PENDING','FINALIZING'))
    OR EXISTS (SELECT 1 FROM public.media_asset WHERE status IN ('UPLOADING','VERIFYING')
      OR "verificationSubmissionUncertain" OR "verificationLeasedUntil">now()
      OR "outputTransferLeaseExpiresAt">now())
    OR EXISTS (SELECT 1 FROM public.outbox_event WHERE status='LEASED' OR "leasedUntil">now())
    OR EXISTS (SELECT 1 FROM public.payment_event WHERE status='PROCESSING' OR "processingLeasedUntil">now())
  THEN RAISE EXCEPTION 'BILLING_ARCHIVE_DATASET_NOT_DRAINED_OR_NOT_TEST'; END IF;
  IF EXISTS (SELECT 1 FROM pg_sequences WHERE schemaname='public')
    OR EXISTS (SELECT 1 FROM pg_views WHERE schemaname='public') THEN
    RAISE EXCEPTION 'BILLING_ARCHIVE_UNREVIEWED_DEPENDENCY';
  END IF;

  CREATE TEMP TABLE cutover_source_tables ON COMMIT DROP AS
    SELECT c.oid,c.relname,pg_get_userbyid(c.relowner) owner_name
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY(names);
  IF (SELECT count(*) FROM cutover_source_tables) <> cardinality(names)
    OR EXISTS (SELECT 1 FROM cutover_source_tables WHERE owner_name <> 'ezpic_app') THEN
    RAISE EXCEPTION 'BILLING_ARCHIVE_UNEXPECTED_TABLE_OWNER';
  END IF;
  FOR item IN SELECT * FROM cutover_source_tables LOOP
    EXECUTE format('SELECT jsonb_build_object(''count'',count(*),''digest'',md5(COALESCE(string_agg(to_jsonb(t)::text,chr(10) ORDER BY t.id COLLATE "C"),''''))) FROM public.%I t',item.relname) INTO actual;
    IF actual IS DISTINCT FROM manifest->'expected'->item.relname THEN
      RAISE EXCEPTION 'BILLING_ARCHIVE_SOURCE_CHANGED: %',item.relname;
    END IF;
  END LOOP;
  CREATE TEMP TABLE cutover_constraints ON COMMIT DROP AS
    SELECT c.conname,rel.relname table_name,ns.nspname schema_name,pg_get_constraintdef(c.oid) definition,
      c.conrelid IN (SELECT oid FROM cutover_source_tables) internal
    FROM pg_constraint c JOIN pg_class rel ON rel.oid=c.conrelid
    JOIN pg_namespace ns ON ns.oid=rel.relnamespace
    WHERE c.contype='f' AND (c.conrelid IN (SELECT oid FROM cutover_source_tables)
      OR c.confrelid IN (SELECT oid FROM cutover_source_tables));
  FOR item IN SELECT * FROM cutover_constraints WHERE NOT internal LOOP
    EXECUTE format('SELECT count(*) FROM %I.%I',item.schema_name,item.table_name) INTO source_count;
    IF item.schema_name <> 'public' OR source_count <> 0 THEN
      RAISE EXCEPTION 'BILLING_ARCHIVE_POPULATED_INBOUND_FOREIGN_KEY';
    END IF;
  END LOOP;
  CREATE TEMP TABLE cutover_triggers ON COMMIT DROP AS
    SELECT pg_get_triggerdef(t.oid) definition FROM pg_trigger t
    WHERE t.tgrelid IN (SELECT oid FROM cutover_source_tables) AND NOT t.tgisinternal;

  -- These are display-only copies. The source ledger and reservations are moved intact.
  UPDATE public.generation_job j
    SET "archivedCreditsCharged"=r."settledAmount", "archivedCreditsReleased"=r."releasedAmount"
    FROM public.credit_reservation r WHERE r."jobId"=j.id;

  EXECUTE format('CREATE SCHEMA %I AUTHORIZATION postgres',archive_name);
  EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC,anon,authenticated,service_role,ezpic_app',archive_name);
  FOR item IN SELECT * FROM cutover_source_tables ORDER BY relname LOOP
    EXECUTE format('ALTER TABLE public.%I SET SCHEMA %I',item.relname,archive_name);
  END LOOP;
  FOR item IN SELECT * FROM cutover_source_tables ORDER BY relname LOOP
    EXECUTE format('CREATE TABLE public.%I (LIKE %I.%I INCLUDING ALL)',item.relname,archive_name,item.relname);
    EXECUTE format('ALTER TABLE public.%I OWNER TO %I',item.relname,item.owner_name);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',item.relname);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC,anon,authenticated,service_role',item.relname);
  END LOOP;
  FOR item IN SELECT * FROM cutover_constraints LOOP
    IF NOT item.internal THEN
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',item.table_name,item.conname);
    END IF;
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I %s',item.table_name,item.conname,item.definition);
  END LOOP;
  FOR item IN SELECT * FROM cutover_triggers LOOP EXECUTE item.definition; END LOOP;
  FOR item IN SELECT * FROM cutover_source_tables LOOP
    EXECUTE format('ALTER TABLE %I.%I OWNER TO postgres',archive_name,item.relname);
    EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM PUBLIC,anon,authenticated,service_role,ezpic_app',archive_name,item.relname);
    EXECUTE format('SELECT jsonb_build_object(''count'',count(*),''digest'',md5(COALESCE(string_agg(to_jsonb(t)::text,chr(10) ORDER BY t.id COLLATE "C"),''''))) FROM %I.%I t',archive_name,item.relname) INTO actual;
    IF actual IS DISTINCT FROM manifest->'expected'->item.relname THEN
      RAISE EXCEPTION 'BILLING_ARCHIVE_COPY_VERIFICATION_FAILED';
    END IF;
  END LOOP;
  INSERT INTO public.billing_plan (id,provider,"providerPriceId","productKind",name,
    "creditsPerPeriod","priceMicros",currency,active,version,metadata,"createdAt","updatedAt")
    SELECT gen_random_uuid()::text,p->>'provider',p->>'providerPriceId',
      (p->>'productKind')::public."PaymentProductKind",p->>'name',
      (p->>'creditsPerPeriod')::bigint,(p->>'priceMicros')::bigint,p->>'currency',
      (p->>'active')::boolean,(p->>'version')::integer,p->'metadata',now(),now()
    FROM jsonb_array_elements(plans) p;
  EXECUTE format('CREATE TABLE %I.cutover_receipt (id text PRIMARY KEY, metadata jsonb NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now())',archive_name);
  EXECUTE format('ALTER TABLE %I.cutover_receipt ENABLE ROW LEVEL SECURITY',archive_name);
  EXECUTE format('REVOKE ALL ON TABLE %I.cutover_receipt FROM PUBLIC,anon,authenticated,service_role,ezpic_app',archive_name);
  EXECUTE format('INSERT INTO %I.cutover_receipt(id,metadata) VALUES ($1,$2)',archive_name) USING archive_name,manifest;
  INSERT INTO public.audit_log(id,action,"targetType","targetId",metadata,"createdAt")
    VALUES(gen_random_uuid()::text,'TEST_BILLING_DATASET_ARCHIVED','DATABASE',archive_name,
      jsonb_build_object('archiveSchema',archive_name,'backup',manifest->'backup','tableCount',cardinality(names),
        'livePlanCount',jsonb_array_length(plans),'originalProviderContracts','PRESERVED_AS_OBSERVED_NOT_ASSERTED_CLOSED'),now());
END;
$cutover$;
