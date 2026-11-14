BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

-- CreateTable
CREATE TABLE "guest_trial_entitlement" (
    "subjectKey" TEXT NOT NULL,
    "trialId" TEXT NOT NULL,
    "reservedJobId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guest_trial_entitlement_pkey" PRIMARY KEY ("subjectKey")
);

-- CreateIndex
CREATE INDEX "guest_trial_entitlement_trialId_idx" ON "guest_trial_entitlement"("trialId");

-- Default-deny before any historical identity is copied. The following private
-- migration grants only application SELECT/INSERT; browser roles get no policy.
ALTER TABLE public.guest_trial_entitlement ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.guest_trial_entitlement FROM PUBLIC;

-- Existing known anonymous owners already used the one-time trial. This receipt
-- intentionally survives guest user/asset retention and campaign changes.
INSERT INTO "guest_trial_entitlement" ("subjectKey", "trialId", "reservedJobId", "createdAt")
SELECT DISTINCT ON ("ownerId") 'owner:' || "ownerId", "id", COALESCE("currentJobId", "consumedJobId"), "createdAt"
FROM "guest_media_trial"
WHERE "ownerId" IS NOT NULL
ORDER BY "ownerId", "createdAt", "id"
ON CONFLICT ("subjectKey") DO NOTHING;

COMMIT;
