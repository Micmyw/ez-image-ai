# EzPic foundation repair design

Date: 2026-08-23  
Branch: `codex/ezpic-foundation-repair`  
Baseline: `8938c213cae8c078bf05433b9acdc89aa96fa0be`

## Authority and evidence

The user's product specification and execution request define the goal. The files under
`docs/foundation-repair/2026-08-23/` are archived GPT proposals supplied for review; they are not
automatically authoritative instructions. This design accepts only proposal claims that can be
reproduced from the repository and adjusts proposals that duplicate or replace working foundation
components.

The historical evidence is in `docs/repository-capability-audit.md`. The repair keeps its original
line references and closes FND-001 through FND-007 on one integration revision. The original EzPic
product specification is preserved byte-for-byte under `docs/product/`.

## Decision

Deliver one foundation-repair branch with six independently reviewable functional commits. Do not
start the EzPic homepage/product PR, do not call paid model providers, and do not replace the
existing PostgreSQL, Outbox, generation-job, attempt, media-asset, or immutable-ledger architecture.

The repair is complete only when all seven findings pass their RED/GREEN tests on the same revision.
Local deterministic evidence is not production certification for Trigger.dev, Stripe, AI providers,
Sightengine, or S3/R2.

## Preserved foundation contracts

- PostgreSQL is the only business source of truth.
- Job creation, input binding, credit reservation, and the initial Outbox event remain one
  serializable transaction.
- Credit mutations are append-only, reference-key idempotent commands. Cached account/lot fields are
  projections, not an alternative ledger.
- Clients submit stable product keys only. Provider routes, credentials, raw payloads, model IDs, and
  costs stay server-side.
- An attempt is persisted before external submission. Uncertain acceptance keeps the reservation and
  prohibits cancellation, release, and automatic failover.
- Private media stays private. Large object transfers stream rather than buffer in application
  memory.
- `MediaAsset.id` identifies an immutable byte object and is sufficient as the version boundary for
  the current product. A separate asset-version aggregate is out of scope.
- Stripe webhook receipt only verifies and durably records events. Workers own business effects.
- Organization billing mutations remain owner-only, and every purchase has exactly one owner.

## FND-001: credit debt, refund settlement, and expiry

### Transaction contract

All credit commands lock in this order: account, relevant lots in deterministic expiry/creation/id
order, reservation, then allocations. A preliminary unlocked read may locate the account, but it
must not authorize a mutation.

After locking the account, commands materialize expired unreserved lot balances. For each expired
lot, remaining spendable value becomes zero and a stable `EXPIRE` ledger entry is appended. Reserved
allocations remain attached to their lots until terminal settlement or release.

Reservation fails with `CREDIT_DEBT_OUTSTANDING` when `creditDebt > 0`. This check occurs inside the
same transaction that would create the job/reservation/outbox, so a rejection leaves none of those
rows behind. A read-side check may improve API feedback but is not the security boundary.

### Refund and terminal command contract

Refunding an active allocation records the revoked amount without prematurely creating debt. If the
reservation later settles, the revoked-settled amount creates an idempotent `DEBT_INCURRED` entry and
increments account debt. If it releases, refunded value is not restored. Value from a lot that has
expired while reserved is also never restored to spendable balance.

The existing grant-first-repays-debt path is retained and covered by regression tests. It is not
reimplemented.

## FND-002: executable route graph and submission certainty

### One executable graph

The declared catalog remains the source of product candidates. A server-only route-graph builder
intersects those candidates with adapter capabilities, configured credentials, environment and
database kill switches, and static Trigger task support. Public catalog, quoting, authorization,
dispatch, and retry consume that same graph interface.

Products without an enabled route are not advertised, quoted, or authorized. A worker rechecks the
persisted route immediately before submission. Historical attempts remain bound to their persisted
route even when it is later disabled; they enter conservative recovery rather than silently moving
to another provider.

Quotes reserve the maximum credit cost of all routes that may legally execute, unless the exact
route is persisted at quote creation. This repair uses one of those two auditable strategies and
tests that dispatch cannot exceed the reserved quote cost.

### Three-way submission decision

Provider submission results are a discriminated `accepted | rejected | uncertain` decision.

- `accepted` requires durable provider acceptance evidence.
- `rejected` is limited to pre-send validation failures or documented provider-specific responses
  that prove the request was not accepted.
- malformed/incomplete 2xx, 429, 5xx, post-send timeout/socket failure, or an unknown provider state
  is `uncertain` by default.

Uncertain decisions persist sanitized evidence, keep the reservation active, and enter the existing
reconciliation/admin flow. Raw provider envelopes and signed URLs are not stored in attempt
snapshots. Provider idempotency capability is stated explicitly; an internal attempt ID is not
misrepresented as remote idempotency.

## FND-003: immutable upload promotion

Every upload session has a server-generated staging key distinct from the final
`MediaAsset.objectKey`. Browser upload URLs grant write access only to staging. The final key is
never returned as a writable target.

Completion claims the session using a persisted `FINALIZING` compare-and-set state. It validates
size and type, streams staging bytes through SHA-256 computation into a newly generated final key,
and conditionally records the final object/checksum before marking the session complete and the
asset verifying. Retried completion returns the same committed result; concurrent completion has a
single winner.

Cleanup addresses staging and final objects independently with reference-key idempotency. Replaying
an old staging PUT may modify only an abandoned staging object; it cannot change a final asset. Both
single-part and multipart flows obey the same promotion boundary. `MediaAsset.id + checksum` is the
immutable content identity used by moderation and generation.

## FND-006 and FND-007: moderation recovery and current retry review

`VERIFYING` means an active or automatically recoverable verification attempt. A new
`VERIFICATION_FAILED` asset status represents exhausted provider/transport verification; it is
fail-closed, cannot receive a signed read URL, and cannot bind to a generation job.

Assets carry a verification generation, bounded attempt count, last sanitized error code, and
exhaustion timestamp. Moderation evidence is append-only per asset/provider/generation and includes
rule version and the strong asset checksum. A result may move an asset to `READY` only when its
generation and checksum still match the asset's current verification claim.

An audited, admin-only, idempotent requeue moves an exhausted asset back to `VERIFYING`, increments
the generation, resets attempt diagnostics, and creates a generation-aware Outbox event. It never
allows an administrator to manufacture an `ALLOW` result.

A user-created generation retry performs current prompt moderation and creates a new quote before
job creation/reservation. It cannot reuse an old approval as a business retry optimization. An
internal replay of the same idempotency key may reuse its already-persisted outcome. Moderation
reject/error creates no job and reserves no credits.

## FND-004: durable Stripe event retries

`PaymentEvent + Outbox + Trigger` remain the only payment-event delivery path. Processing outcomes
are explicit:

- processed or idempotently skipped: mark terminal success and return;
- unsupported event: mark `IGNORED` and return;
- terminal schema/binding/business error: mark `DEAD_LETTER`, audit, and return;
- transient infrastructure/order dependency: record the failed attempt and sanitized class, then
  throw so Trigger performs its bounded retry;
- final transient attempt: persist `DEAD_LETTER`, then throw so the Trigger run also records failure.

Attempt number, run ID, last-attempt time, and error class are stored. Actual next-run scheduling is
owned by Trigger and is not guessed in PostgreSQL. Admin replay creates a new Outbox delivery while
preserving the original event and audit trail.

## FND-005: Stripe reconciliation, refund finality, and purchase ownership

A narrow server-side Stripe billing-source interface supports fixture-driven tests and a real Stripe
implementation. Reconciliation pages external subscription, paid invoice, and refund facts using a
durable cursor. API failures never cancel local entitlements; ambiguous owner/price/customer binding
becomes needs-review.

Each provider refund has one local lifecycle record. `PENDING` changes no credits. Only a monotonic
transition to `SUCCEEDED` invokes the existing credit-refund command with a stable refund/period
reference. `FAILED` or `CANCELED` changes no credits. Partial refunds derive cumulative refundable
credits from the original paid amount and subtract already finalized credits, preventing rounding
drift or over-refund.

Webhook event IDs remain receipt dedupe keys; normalized refund IDs are not unique PaymentEvent
keys. `refund.created`, `refund.updated`, `refund.failed`, and compatible charge events update the
same Refund record.

New purchases must satisfy exactly one of `userId` or `organizationId`. The database adds an initial
`NOT VALID` XOR constraint so unknown historical rows are reported rather than guessed. API portal
authorization explicitly rejects zero-owner and dual-owner rows before any Stripe call. A later
operator migration may repair historical rows and validate the constraint.

## CI and verification environment

The mock media E2E job receives a private MinIO service and deterministic bucket initialization;
PostgreSQL alone is insufficient for upload tests. Local verification uses task-owned PostgreSQL and
MinIO resources and removes only those resources at the end.

The full format gate currently fails on the clean baseline because 781 tracked files differ under
the local Oxfmt/line-ending environment. This is recorded as a baseline defect. The repair will
identify and correct the repository/tooling cause without silently committing an unrelated
781-file rewrite. Trigger Cloud build remains an external configuration gate and is reported
separately from local type/contract verification.

## Migration and rollback

Migrations are additive or forward-compatible first. Historical ambiguous ownership, legacy
moderation evidence, already-expired credit lots, and already-applied pending refunds are diagnosed;
the migration does not invent provenance or silently rewrite financial history.

Feature kill switches may stop new generation and automatic recovery during rollback. Migrations
must remain readable by the preceding application where practical. Rollback never deletes ledger,
refund, payment-event, attempt, moderation, or audit evidence.

## Explicit non-goals

- EzPic branding, homepage, pricing, SEO, legal pages, or PR 2 through PR 7.
- A new job queue, ledger, moderation platform, `AssetVersion` tree, or payment admin product.
- Real paid Provider calls or claims of live Trigger/Stripe/Sightengine/S3 certification.
- Repairing unrelated anonymous-draft buffering, image decompression/EXIF policy, analytics schema,
  or general admin UI completeness.
