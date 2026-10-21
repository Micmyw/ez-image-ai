BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

-- CreateTable
CREATE TABLE "growth_event" (
    "id" TEXT NOT NULL,
    "sessionHash" TEXT NOT NULL,
    "userId" TEXT,
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL,
    "path" TEXT,
    "source" TEXT,
    "medium" TEXT,
    "campaign" TEXT,
    "device" TEXT NOT NULL,
    "productKind" TEXT,
    "errorCategory" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "growth_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "growth_event_createdAt_idx" ON "growth_event"("createdAt");

-- CreateIndex
CREATE INDEX "growth_event_sessionHash_createdAt_idx" ON "growth_event"("sessionHash", "createdAt");

-- CreateIndex
CREATE INDEX "growth_event_userId_createdAt_idx" ON "growth_event"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "growth_event" ADD CONSTRAINT "growth_event_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Supplemental server-only boundary, following the existing private PostgreSQL migrations.
-- Better Auth users are not Supabase browser identities.
ALTER TABLE "growth_event" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "growth_event" FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ezpic_app') THEN
  GRANT SELECT, INSERT, UPDATE, DELETE ON "growth_event" TO ezpic_app;
  CREATE POLICY growth_event_app ON "growth_event" TO ezpic_app USING (true) WITH CHECK (true);
 END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
  REVOKE ALL ON "growth_event" FROM anon;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
  REVOKE ALL ON "growth_event" FROM authenticated;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
  REVOKE ALL ON "growth_event" FROM service_role;
 END IF;
END $$;
COMMIT;
