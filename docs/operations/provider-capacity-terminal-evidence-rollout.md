# Provider capacity terminal evidence rollout

Provider occupancy and customer billing resolution are separate facts. A Kie task
can have a verified terminal result while its charge or unusable output still
requires manual reconciliation. The latter must keep the existing reservation
and moderation rules without occupying a supplier execution slot forever.

## Evidence written by this change

Only the legacy reconciliation path, immediately after the server adapter's
authenticated `kie-record-info` retrieval, writes
`generation_attempt.responseSnapshot.providerTerminalEvidence`. It records:

- `version: 1`, `provider: "kie"`, `source: "kie-record-info"`;
- the persisted attempt ID and original provider task ID;
- `SUCCEEDED`, `FAILED`, or `CANCELED` and the retrieval's `verifiedAt` timestamp.

The attempt lease, provider, job, and task identities are checked under the row
lock, and the marker commits in the same transaction as the observation. Callback
JSON, operator reasons, elapsed leases, `completedAt`, HTTP 429/5xx, and missing
results cannot create this evidence. Capacity checks bind it back to the attempt
row. Snapshot sanitization preserves a valid existing marker; a late create
acknowledgement cannot overwrite the verified terminal state.

The marker authorizes only release of provider occupancy. It never grants an
output read, marks an image approved, releases/settles credits, retries a paid
submission, or changes the job's manual reconciliation status.

## Deployment preflight

1. Run the focused unit tests and PostgreSQL capacity suite. Generated-client
   integration/build checks remain separate gates and must not be reported as
   passed when Prisma generation is unavailable.
2. Verify the actual provider account and configured capacity for each runtime.
   A missing/invalid Kie capacity queues sends; it does not invent a supplier cap.
3. Timestamp validation uses string operations over canonical UTC timestamps,
   including Gregorian calendar/leap-day checks and a UTC current-time bound.
   It does not cast untrusted date text or require PostgreSQL 16 functions.
4. Inventory unresolved historical attempts before switching traffic. This
   change does not automatically release old manual attempts without a marker.

## Historical attempts: read-only investigation first

No production investigation or backfill is executed as part of this patch.
The following query is an inventory, not permission to release capacity:

```sql
SELECT "id", "jobId", "provider", "providerTaskId", "status",
       "uncertainSubmission", "completedAt"
FROM "generation_attempt"
WHERE "provider" = 'kie'
  AND "status" = 'NEEDS_RECONCILIATION'
  AND ("submittedAt" IS NOT NULL OR "providerTaskId" IS NOT NULL
       OR "uncertainSubmission")
  AND "responseSnapshot"->'providerTerminalEvidence' IS NULL
ORDER BY "updatedAt", "id";
```

For a task with a persisted original task ID, use the existing server-side
authenticated retrieval adapter and its server-derived record-info URL. Do not
use a customer-supplied URL, make a create/submit request, print authentication
headers, or include signed output URLs in the report. Record only the identity,
retrieval source, observed status, and timestamp needed for restricted review.
Missing task IDs, running/unknown results, retrieval errors, and ambiguous or
unsupported response formats retain occupancy. A previous callback or manual
reason does not replace this retrieval.

After that evidence is reviewed under the separate production change process,
a backfill operation can lock the same attempt, recheck provider/task identity,
validate the structured marker, and append the marker plus an audit entry in one
transaction. Preserve all job/attempt billing statuses, uncertainty flags,
credit/storage reservations, and moderation evidence. If the row changed, skip
it and investigate again. This patch does not include or run such a writer.

The same conservative rule applies to future manual cases that have only a
callback and no authenticated retrieval marker. They need verified observation;
they are never released by age or by a convenient reason string.
