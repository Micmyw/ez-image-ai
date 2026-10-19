# Subscriber storage: deploy the output consumer first

This compatibility split is based on `10940ad02a12530ddfea0f4b425bfef0a0793da8`.
The full producer proposal is PR27, `b9eba695c153d695df5d896f7a712ff19f983f2f`.
Its `docs/implementation/subscriber-storage-unlimited-2026-10-19.md` already requires
a compatible jobs consumer before the website producer.

## Exact split

The production change consists of:

- `packages/database/prisma/queries/media/storage-quota.ts`: the same helper as PR27,
  using existing subscription eligibility and the existing job JSON snapshot.
- `packages/database/prisma/queries/media/assets.ts`: only the generated-output
  reservation lookup and nullable aggregate-cap comparison.
- `packages/database/prisma/queries/media/video-v1-fulfillment.ts`: only the native
  and template video output capacity/recovery lookup and nullable comparison.

The helper's pure snapshot-writing functions are present for compatibility with
PR27, but no producer calls them in this split. No new package export is needed:
both consumers import the helper directly.

Upload sessions, temporary references, draft imports, image/video job admission,
quote/create preflight, retry reconciliation and `MEDIA_MAX_STORAGE_BYTES` remain
unchanged. This split does not admit new unlimited jobs or write
`aggregateStoragePolicy` into job snapshots. It adds no schema, migration, binding,
environment flag or dependency.

## Output compatibility

The helper reads only the authoritative owner-scoped job, either directly by job
ID or through its owner-scoped `OUTPUT` asset binding. Asset metadata and client
input cannot grant unlimited storage.

- A job with `{aggregateStoragePolicy: {schemaVersion: 1, maximumBytes: null}}`
  keeps its admitted unlimited-output promise after subscription expiry.
- Otherwise the existing effective paid-subscription query determines current
  output eligibility. A current paid subscriber can finish historical output or
  an output admitted before upgrading.
- A free owner without a frozen unlimited promise keeps the current configured
  cap, including when an old job recorded a larger finite cap. Missing historical
  policy falls back to this same paid/free rule. Invalid frozen policy rejects.

Every successful output still reserves the real byte amount. Existing owner,
transfer-token/lease, authenticated provider-success, immutable output, per-file,
review and credit fences remain in their original transactions. Native video
continues to honor already-reserved output capacity before consulting fallback
quota, as before.

## Release and rollback order

1. Merge and deploy this consumer split to the actual jobs runtime used by both
   legacy image fulfillment and native/template video fulfillment. Confirm its
   active version before enabling the producer; merging two PRs back-to-back is
   not deployment-order evidence. Deploying the same compatibility code to the
   website is harmless because its admission paths still enforce their old caps.
2. Rebase PR27 on the consumer commit, retaining its admission/preflight/freeze,
   upload, draft, temporary-reference and retry-comparison changes as the separate
   producer phase. Keep the full helper identical. Deploy that phase only after
   the consumer version is confirmed active.
3. To roll back the producer, close new unlimited admission first. Keep this
   consumer version, or a later compatible version, while any accepted unlimited
   snapshot or unfinished output still needs fulfillment/recovery. Do not roll
   the jobs consumer back to the old finite-only comparison during that drain.

No production deployment or database operation was performed for this split.

## Local evidence and limits

Before the source patch, the real image/video output transaction regression suite
ran 15 cases: 9 passed and 6 failed on the old finite-only quota checks. Failures
covered admitted unlimited output, current paid historical output, and invalid
snapshot rejection in both consumers.

After the patch, the three focused suites pass 55 tests: output consumers (15),
shared policy (18), and existing upload transactions (22). The new transaction
tests use in-memory database delegates with the real storage transactions,
subscription query logic and quota helper. Global client construction and the
unrelated credit mutation module are isolated; any credit mutation in these
storage tests throws. These are not PostgreSQL concurrency or Cloudflare runtime
certification. The official generated Prisma client is absent in this environment;
no substitute client or download bypass is used.

Changed-file formatting and lint pass. Lint retains four warnings on existing
Prisma payload types in the two consumer files. Database type checking exits 2
because the official generated modules are absent; the new helper likewise has a
missing type-only `../../generated/client` import. No live PostgreSQL assertions
were run. Generated-client, PostgreSQL and deployed-runtime validation remain
required release evidence rather than claims from these local tests.

Evidence logs: `/tmp/storage-consumer-red.json` and
`/tmp/storage-consumer-green.json`. CI, push, PR creation and deployment are left
to the parent after reviewing this local commit.
