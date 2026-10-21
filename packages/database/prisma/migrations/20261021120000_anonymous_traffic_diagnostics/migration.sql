BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

-- AlterTable
ALTER TABLE "growth_event" ADD COLUMN     "diagnostics" JSONB;

-- CreateTable
CREATE TABLE "traffic_aggregate" (
    "hour" TIMESTAMPTZ(3) NOT NULL,
    "path" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "device" TEXT NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "traffic_aggregate_pkey" PRIMARY KEY ("hour","path","source","device")
);

ALTER TABLE "traffic_aggregate" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "traffic_aggregate" FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ezpic_app') THEN
  GRANT SELECT, INSERT, UPDATE, DELETE ON "traffic_aggregate" TO ezpic_app;
  CREATE POLICY traffic_aggregate_app ON "traffic_aggregate" TO ezpic_app USING (true) WITH CHECK (true);
 END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
  REVOKE ALL ON "traffic_aggregate" FROM anon;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
  REVOKE ALL ON "traffic_aggregate" FROM authenticated;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
  REVOKE ALL ON "traffic_aggregate" FROM service_role;
 END IF;
END $$;
COMMIT;
