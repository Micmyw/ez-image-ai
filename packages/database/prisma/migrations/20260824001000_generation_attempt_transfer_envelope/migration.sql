CREATE TABLE "generation_attempt_transfer_envelope" (
  "attemptId" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "generation_attempt_transfer_envelope_pkey" PRIMARY KEY ("attemptId"),
  CONSTRAINT "generation_attempt_transfer_envelope_attemptId_fkey"
    FOREIGN KEY ("attemptId") REFERENCES "generation_attempt"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- Move legacy transfer candidates out of the ordinary attempt snapshot. The worker
-- validates this bounded envelope before use and sends malformed legacy rows to
-- manual reconciliation rather than trusting them during migration.
INSERT INTO "generation_attempt_transfer_envelope" ("attemptId", "payload", "createdAt", "updatedAt")
SELECT
  "id",
  jsonb_build_object('version', 1, 'outputs', "responseSnapshot"->'outputs'),
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "generation_attempt"
WHERE CASE
  WHEN jsonb_typeof("responseSnapshot"->'outputs') = 'array'
    THEN jsonb_array_length("responseSnapshot"->'outputs') > 0
  ELSE false
END
ON CONFLICT ("attemptId") DO NOTHING;

UPDATE "generation_attempt"
SET "responseSnapshot" = jsonb_build_object(
  'providerCharged', CASE
    WHEN "responseSnapshot"->'providerCharged' = 'true'::jsonb THEN true
    ELSE false
  END,
  'outputCount', CASE
    WHEN jsonb_typeof("responseSnapshot"->'outputs') = 'array'
      THEN jsonb_array_length("responseSnapshot"->'outputs')
    ELSE 0
  END
)
WHERE "responseSnapshot" ? 'outputs';
