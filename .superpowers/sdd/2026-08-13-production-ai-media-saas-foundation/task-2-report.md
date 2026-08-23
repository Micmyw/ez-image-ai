# Task 2 Report: Prisma media domain and transactional persistence

Status: DONE

## Scope delivered

- Added the Prisma-only AI media domain: quotes, jobs, attempts, assets/uploads/moderation,
  storage reservations, immutable credits with FIFO allocation rows, provider/payment envelopes,
  Outbox, billing, runtime overrides, audits, fixed-window rate limits, and drafts.
- Kept the existing `Purchase` model and added the optional one-to-one
  `Subscription.purchaseId @unique` compatibility bridge.
- Implemented serializable/retryable job creation. One transaction validates a non-expired quote,
  creates the job, locks `CreditAccount`, locks FIFO `CreditLot` rows in
  expiry/createdAt/id order, creates `CreditReservation` and allocation rows, binds READY
  user-owned input assets, and appends `JOB_CREATED` to Outbox. Owner/idempotency replay returns
  the existing job and reservation.
- Added conditional job state/version transitions, unique attempts/provider tasks, immutable
  ledger reserve/settle/release/grant/refund/debt entries, envelope ingestion separated from
  processing/grants, `FOR UPDATE SKIP LOCKED` Outbox leases and dead letters, asset/user cursor
  pages, and operations/billing helpers.
- Database helpers return BigInt domain values. No helper JSON-stringifies BigInt; API DTO
  conversion remains an explicit downstream responsibility.

## TDD evidence

### RED: state machine

Command:

```text
pnpm --filter @repo/database test
```

Raw summary:

```text
FAIL prisma/queries/media/state-machine.test.ts
Error: Cannot find module './state-machine'
Test Files 1 failed (1); Tests no tests; exit 1
```

The missing production module was the expected failure. After the minimal implementation:

```text
Test Files 1 passed (1); Tests 17 passed (17)
```

### RED: PostgreSQL transactions

Command:

```text
pnpm --filter @repo/database test:integration
```

Raw summary before the domain/client implementation:

```text
FAIL prisma/queries/media/media.integration.test.ts
Error: Cannot find module '../../generated/client'
Test Files 1 failed (1); Tests no tests; exit 1
```

After migration and implementation, the final isolated PostgreSQL run is:

```text
Test Files 1 passed (1); Tests 11 passed (11)
```

It covers concurrent reserve bounds, duplicate job/reservation/outbox, stale job transitions,
FIFO allocation, duplicate provider events, duplicate settlement, refund debt and debt repayment,
expired Outbox lease recovery/dead-lettering, asset cursor pagination, ledger UPDATE/DELETE
rejection, aggregate CHECK constraints, and cross-table/ledger invariants.

## Database safety and migration evidence

Integration connects only through `TEST_DATABASE_URL`. The safety gate rejects a missing value,
rejects equality with `DATABASE_URL`, and accepts only localhost/loopback databases whose name
contains `test` or `testing`. No development or production database was read or changed.

Fail-closed command with both variables absent:

```text
pnpm --filter @repo/database test:integration
Error: BLOCKED_BY_ENVIRONMENT: TEST_DATABASE_URL is required
Test Files 1 failed (1); exit 1
```

The authorized disposable target was `127.0.0.1:55432/ai_media_foundation_test`. It was dropped,
recreated empty, and received only this migration:

```text
Applying migration `20260813000000_ai_media_foundation`
All migrations have been successfully applied.
```

Schema drift inspection after deploy:

```text
prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
No difference detected.
```

PostgreSQL catalog inspection confirmed:

- credits, balances, debt, costs, sizes, and price micros are `bigint`;
- Task 2 timestamps are `timestamp with time zone`;
- required JSON snapshot/envelope columns are non-null;
- CHECK constraints reject negative account, lot, reservation, allocation, ledger, storage,
  billing, and rate-limit amounts;
- partial hot-path indexes exist for non-terminal jobs, pending/leased Outbox, unprocessed provider
  and payment events, expiring spendable lots, and stale upload sessions;
- the non-null normalized transaction identifier uses a partial unique index;
- trigger `credit_ledger_entry_immutable` exists for both UPDATE and DELETE.

This is the repository's first migration, so it is a full initial schema and is safe only for a
confirmed empty database. `prisma/migrations/README.md` explicitly forbids blindly applying it to
an existing Supastarter deployment. Existing deployments must generate/review/apply an actual
database-to-current-schema delta in staging, validate it, and only then mark this initial migration
as baselined with `migrate resolve --applied`.

## Final verification

```text
pnpm --filter @repo/database generate
PASS: Prisma Client 7.8.0 and Prisma Zod output generated

pnpm --filter @repo/database type-check
PASS: tsc --noEmit, exit 0

pnpm --filter @repo/database test
PASS: 1 file, 17 tests

TEST_DATABASE_URL=<isolated-local-test-url> pnpm --filter @repo/database test:integration
PASS: 1 file, 11 tests

pnpm exec oxlint --deny-warnings --tsconfig packages/database/tsconfig.json <Task 2 TypeScript>
PASS: exit 0, no warnings

pnpm exec oxfmt --check <Task 2 files>
PASS: all matched files use the correct format

git diff --check
PASS: no whitespace errors
```

Package linking used `pnpm install --filter @repo/database... --offline --ignore-scripts`; it
downloaded zero packages and did not request the known-blocking Next 16.2.6 tarball.

## Concerns and downstream contract

- Provider and payment signature verification is intentionally upstream. These helpers require a
  `verifiedAt` timestamp and persist the verified raw envelope atomically with processing Outbox;
  they do not claim to verify signatures themselves.
- Only `ownerType = USER` is accepted for first-release asset, quote, job, storage, and draft write
  helpers. The schema retains generic owner fields for the future organization release.
- API/oRPC code must map BigInt domain objects to explicit JSON-safe DTO strings; direct
  `JSON.stringify` remains prohibited.

## Review-fix round 1: refund safety, Outbox CAS, and replay conflicts

### RED

Command (isolated PostgreSQL only):

```powershell
$env:TEST_DATABASE_URL='postgresql://ai_media_test:ai_media_test_only@127.0.0.1:55432/ai_media_foundation_test?schema=public'
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
pnpm --filter @repo/database test:integration
```

Raw summary before the review fixes:

```text
Test Files 1 failed (1)
Tests 6 failed | 11 passed (17)
```

The six expected failures proved the reviewed defects: a fully refunded reserved grant restored
10 spendable credits and created 10 debt, a partial refund restored 6 instead of 2 and created 4
debt, an expired matching lot created 7 false debt, an Outbox claim returned no lease token, and
conflicting grant/refund and reserve/finalize replays silently returned earlier results.

### GREEN

The same command after the minimal fixes:

```text
Test Files 1 passed (1)
Tests 17 passed (17)
```

The integration suite now also asserts that identical grant, refund, and reserve commands return
their original records while reuse with a different account, amount, job, reservation, or command
fails explicitly with `IDEMPOTENCY_CONFLICT`. Outbox completion and release now compare an exact
per-claim lease token, including reclaim by the same worker ID.

### Additive migration and drift

The disposable database `127.0.0.1:55432/ai_media_foundation_test` was dropped, recreated empty,
and received both committed migrations in order:

```text
Applying migration `20260813000000_ai_media_foundation`
Applying migration `20260813010000_credit_replay_safety`
All migrations have been successfully applied.
```

The second migration is additive: it persists reservation revocation accounting and adds the
Outbox lease capability token. Drift verification against the freshly migrated database returned:

```text
prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
No difference detected.
```

### Review-fix final verification

```text
DATABASE_URL=<isolated-local-test-url> pnpm --filter @repo/database generate
PASS: Prisma Client 7.8.0 and Prisma Zod output generated

pnpm --filter @repo/database type-check
PASS: tsc --noEmit, exit 0

pnpm --filter @repo/database test
PASS: 1 file, 17 tests

TEST_DATABASE_URL=<isolated-local-test-url> pnpm --filter @repo/database test:integration
PASS: 1 file, 17 tests

pnpm exec oxlint --deny-warnings --tsconfig packages/database/tsconfig.json <review-fix TypeScript>
PASS: exit 0, no warnings

pnpm exec oxfmt --check <review-fix files>
PASS: all matched files use the correct format

git diff --check
PASS: no whitespace errors
```

The existing deployment-baseline warning above remains unchanged: the initial migration must not
be blindly applied to an existing Supastarter database.

## Review-fix round 2: concurrent financial replay races

### RED

Command (isolated PostgreSQL only):

```powershell
$env:TEST_DATABASE_URL='postgresql://ai_media_test:ai_media_test_only@127.0.0.1:55432/ai_media_foundation_test?schema=public'
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
pnpm --filter @repo/database test:integration -- --testNamePattern "concurrent cross-account|concurrent identical"
```

Raw summary before the concurrency-boundary fix:

```text
Test Files 1 failed (1)
Tests 1 failed | 1 passed | 17 skipped (19)
PrismaClientKnownRequestError: Raw query failed. Code: `40001`.
Message: `could not serialize access due to concurrent update`
```

The failing identical-command case exposed adapter-wrapped SQLSTATE `40001` as Prisma `P2010`
instead of the `P2034` previously handled by `runSerializable`. A PostgreSQL trigger scoped only to
the test reference/account then deterministically held one cross-account ledger insert until the
other committed, proving the unique-key loser must load the winner outside the aborted transaction.

### GREEN

The focused PostgreSQL concurrency run after the fix:

```text
Test Files 1 passed (1)
Tests 3 passed | 17 skipped (20)
```

It covers a cross-account ledger reference-key race, an identical concurrent grant replay, and a
cross-account reservation `jobId` race. Conflicting losers now surface
`IdempotencyConflictError`, never raw `P2002`; identical commands return the winner's canonical
record and commit one ledger effect. Adapter-wrapped SQLSTATE `40001` and
`TransactionWriteConflict` remain within the existing four-attempt serializable retry loop.

### Review-fix final verification

```text
pnpm --filter @repo/database type-check
PASS: tsc --noEmit, exit 0

pnpm --filter @repo/database test
PASS: 1 file, 17 tests

TEST_DATABASE_URL=<isolated-local-test-url> pnpm --filter @repo/database test:integration
PASS: 1 file, 20 tests

pnpm exec oxlint --deny-warnings --tsconfig packages/database/tsconfig.json <review-fix TypeScript>
PASS: exit 0, no warnings

pnpm exec oxfmt --check <review-fix files>
PASS: all matched files use the correct format

git diff --check
PASS: no whitespace errors
```

## Review-fix round 3: deterministic identical-command overlap evidence

### RED

Command (isolated PostgreSQL only):

```powershell
$env:TEST_DATABASE_URL='postgresql://ai_media_test:ai_media_test_only@127.0.0.1:55432/ai_media_foundation_test?schema=public'
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
pnpm --filter @repo/database test:integration -- --testNamePattern "canonical result for concurrent identical"
```

The test used a PostgreSQL trigger plus transaction-scoped advisory lock to hold the first grant
after its initial reference lookup and before commit. It verified the lock was held before starting
the second call, then failed because the old production boundary exposed no retry observation:

```text
Test Files 1 failed (1)
Tests 1 failed | 19 skipped (20)
AssertionError: expected false to be true
```

The failed assertion required at least one observed `SERIALIZATION_CONFLICT`, proving the former
`Promise.all` test could not establish that both transactions exercised the contention path.

### GREEN

`runSerializable` now accepts an optional attempt observer and reports attempt start and recognized
serialization conflict events. The observer does not change isolation, timing, retry conditions,
or the four-attempt limit. The deterministic integration test now proves database overlap, an
adapter-wrapped serialization conflict, bounded retry, one canonical result, and one ledger effect:

```text
Test Files 1 passed (1)
Tests 1 passed | 19 skipped (20)
```

### Review-fix final verification

```text
pnpm --filter @repo/database type-check
PASS: tsc --noEmit, exit 0

pnpm --filter @repo/database test
PASS: 1 file, 17 tests

TEST_DATABASE_URL=<isolated-local-test-url> pnpm --filter @repo/database test:integration
PASS: 1 file, 20 tests

pnpm exec oxlint --deny-warnings --tsconfig packages/database/tsconfig.json <review-fix TypeScript>
PASS: exit 0, no warnings

pnpm exec oxfmt --check <review-fix files>
PASS: all matched files use the correct format

git diff --check
PASS: no whitespace errors
```
