# EzPic foundation repair implementation plan

Date: 2026-08-23  
Design: `docs/superpowers/specs/2026-08-23-ezpic-foundation-repair-design.md`

## Execution rules

- Work only in `codex/ezpic-foundation-repair` and stage only intended files.
- Preserve the six functional units as separate conventional commits; documentation may have its
  own baseline commit.
- For every behavior change, first add a focused test that fails for the intended reason, retain the
  RED command/output in the repair evidence, then implement the smallest coherent GREEN change.
- After each unit, run focused format/lint/type/test checks and one independent feature-level review.
  Fix Critical/Important findings before continuing.
- Do not pause for design approval: the user authorized uninterrupted repair. Stop only for an
  external authority/credential barrier that cannot be resolved with deterministic fakes.

## Task 0: preserve evidence and freeze the repair contract

Files:

- `docs/product/2026-08-23-ezpic-ai-image-editor-spec.md`
- `docs/repository-capability-audit.md`
- `docs/foundation-repair/2026-08-23/*`
- this plan and the repair design

Actions:

1. Verify the product specification SHA-256 is
   `4677B0FC33D7DD8773C206DEA1CEA4389354D0CCD8BD0A1BBBAF2B138C670B24`.
2. Label the ZIP documents as proposals in the design rather than silently adopting their workflow.
3. Record baseline unit/contracts, format, lint, type, migration, integration, and external-service
   boundaries.
4. Commit documentation without application changes.

## Task 1: credits, debt, refund settlement, and expiry

Primary files:

- `packages/database/prisma/schema.prisma` and one forward migration
- `packages/database/prisma/queries/media/credits.ts`
- credit command/types/idempotency/invariant helpers
- generation authorization/error mapping
- database and API credit/payment tests

RED cases:

- positive debt rejects creation atomically with no job/reservation/allocation/outbox;
- refund of an active allocation followed by settlement creates exactly one debt entry;
- the same refund followed by release restores no refunded value and creates no debt;
- lot expiry is ledgered once; expired reserved value settles but never revives on release;
- grant less/equal/greater than debt and repeated reference keys preserve projections;
- serializable concurrency for reserve/refund/settle/release/grant/expire maintains invariants.

GREEN implementation:

1. Add `EXPIRE` and the idempotent expiry command/materialization helper.
2. Enforce debt after account lock inside reservation.
3. Add revoked-settlement debt and expired-release rules using deterministic locks/reference keys.
4. Keep existing grant repayment behavior and extend invariant reporting.
5. Run migration, focused database/API tests, invariant verifier, and independent review.

Commit: `fix(credits): enforce debt refund and expiry invariants`

## Task 2: executable routes, bounded cost, and submission certainty

Primary files:

- AI catalog/routing/provider contracts
- API public catalog, quote, and generation authorization
- jobs runtime/dispatch/Trigger route manifest
- attempt schema/migration only for evidence that the existing model cannot represent
- provider/dispatch/database tests

RED cases:

- a declared route without an enabled adapter is absent from public catalog and authorization;
- static Trigger tasks and executable graph candidates cannot diverge;
- quote reservation bounds every route dispatch may choose;
- environment and database kill switches stop pre-submit dispatch;
- malformed/incomplete 2xx, 429/5xx, and post-send failures become uncertain;
- only proven pre-send/documented rejection permits retry/failover;
- uncertain attempts keep reservation active and never create a second external attempt.

GREEN implementation:

1. Build one immutable executable route graph from catalog plus capabilities/config/runtime controls.
2. Route public catalog, quote, authorization, claim, dispatch, and retry through the graph.
3. Introduce discriminated submission decisions and sanitized evidence.
4. Persist a pre-submit boundary/fingerprint only where required for crash-safe classification.
5. Run fake HTTP provider matrix, dispatch security/database tests, and independent review.

Commit: `fix(ai): enforce executable routes and submission certainty`

## Task 3: immutable staging-to-final upload promotion

Primary files:

- storage provider streaming/copy/delete helpers
- upload-session schema/migration and media asset queries/procedures
- cleanup and verification handlers
- storage unit, database integration, and MinIO attack regression tests

RED cases:

- browser upload target differs from the final object key;
- replaying the old signed PUT after completion cannot change a signed read or moderation hash;
- two completion requests promote once and return the same result;
- strong SHA-256, size, and type mismatch fail closed;
- multipart and single-part follow the same promotion boundary;
- crash/retry and staging/final cleanup are idempotent; no public bucket access exists.

GREEN implementation:

1. Add staging key and a durable `FINALIZING` session claim.
2. Generate an unexposed final key and stream staging to final while hashing.
3. Atomically commit checksum/object identity, enqueue verification, and make completion replay-safe.
4. Extend object-level cleanup and generation/moderation checksum binding.
5. Run MinIO regression, integration tests, and independent review.

Commit: `fix(storage): promote uploads into immutable media assets`

## Task 4: moderation exhaustion recovery and current retry review

Primary files:

- media asset/moderation schema and migration
- upload verification runtime/Trigger/outbox handlers
- admin operations and diagnostics
- quote/retry moderation service and procedure
- moderation/database/API tests

RED cases:

- bounded transient failures end in `VERIFICATION_FAILED`, not permanent `VERIFYING`;
- stale generations or checksum-mismatched evidence cannot make an asset ready;
- admin requeue is authorized, reasoned, audited, idempotent, and generation-aware;
- a user business retry always invokes current prompt moderation and creates a new quote;
- reject/error creates no job or reservation; identical internal replay has one outcome.

GREEN implementation:

1. Add verification generation/attempt/error/exhaustion state and immutable evidence fields.
2. Make the worker claim/record each attempt and atomically exhaust after the configured bound.
3. Add admin-only requeue and diagnostics without an admin bypass-to-ready action.
4. Replace prior-ALLOW reuse with current moderation/quote creation for business retry.
5. Run focused moderation/admin/database tests and independent review.

Commit: `fix(moderation): recover verification and recheck retries`

## Task 5: payment worker retries and purchase ownership

Primary files:

- payment-event and purchase schema/migration
- Stripe processor and Trigger wrapper
- portal procedure and payment/admin diagnostics
- payment/Trigger/API/database tests

RED cases:

- transient processing failure persists diagnostics and rejects the Trigger run;
- last transient attempt dead-letters and still rejects the run;
- terminal and ignored outcomes do not hot-loop; admin replay is independently idempotent;
- zero-owner and dual-owner purchases are rejected before Stripe; valid user/org owners pass;
- new database rows cannot violate purchase XOR ownership.

GREEN implementation:

1. Add event attempt/terminal fields and `IGNORED`/`DEAD_LETTER` states.
2. Thread Trigger run context into processing and rethrow transient failures safely.
3. Add Purchase XOR migration and explicit portal fail-closed checks.
4. Run payment/Trigger/API tests and independent review.

Commit: `fix(payments): retry events and enforce purchase ownership`

## Task 6: Stripe final-state reconciliation and safe refunds

Primary files:

- Refund/reconciliation schema and migration
- Stripe narrow billing-source interface and implementation
- reconciliation handlers/Trigger tasks
- Stripe processor/webhook normalization
- credit refund integration and fixtures

RED cases:

- multiple webhook event IDs for one refund are retained and update one refund lifecycle;
- pending refund changes no credits; succeeded finalizes once; failed/canceled changes none;
- repeated/out-of-order events do not regress terminal state;
- cumulative partial refunds cannot exceed paid credits and have stable rounding;
- paged external reconciliation repairs missing subscription/invoice/refund events;
- Stripe transient/ambiguous binding preserves entitlement and creates diagnostics;
- refund against an active reservation obeys Task 1 settlement/release debt invariants.

GREEN implementation:

1. Remove normalized transaction uniqueness as an event receipt boundary and add Refund lifecycle.
2. Finalize only succeeded refunds through the unique credit-refund command.
3. Add cursor-backed reconciliation over the narrow billing-source interface.
4. Preserve monotonic subscription/period/refund transitions and needs-review diagnostics.
5. Run fixture/integration tests and independent review.

Commit: `fix(payments): reconcile stripe and finalize refunds safely`

## Task 7: CI storage service and one-revision revalidation

Primary files:

- `.github/workflows/validate-prs.yml`
- test infrastructure/scripts and repair evidence appendix
- formatting/tooling configuration only if the clean-baseline root cause is proven

Actions:

1. Add MinIO and deterministic private bucket setup to mock media E2E CI.
2. Diagnose the 781-file Oxfmt baseline mismatch; fix configuration/line-ending cause without a
   broad unrelated source rewrite.
3. On a clean isolated PostgreSQL/MinIO environment, run frozen install, migrations, drift check,
   format gate, lint, type-check, unit/contracts, integration, invariants, load smoke, provider fake
   matrix, and relevant Playwright.
4. Run Trigger type/local build checks when local inputs permit; report protected Trigger Cloud
   variable/secret gates separately.
5. Run one broad independent review on the complete diff, fix Critical/Important issues, rerun
   proportional tests, and verify the worktree is clean.
6. Update the audit with a closure appendix that maps FND-001 through FND-007 to RED evidence,
   implementation, GREEN evidence, and remaining live-service gates.

Commit: `test(ci): revalidate repaired media foundation`

## Completion boundary

Completion permits resuming only the no-model-cost EzPic product PR 1. Production enablement still
requires separate live Trigger.dev staging, bounded real-provider, production S3/R2/Sightengine, and
Stripe test-mode acceptance evidence. Do not push, merge, deploy, or begin later product PRs without
separate user authorization.
