# EzPic

EzPic is a focused, private prompt-based AI image editor. Its public product offers Standard Edit
and Quality Edit as upload-first, image-to-image workflows while retaining the existing AI media
foundation for jobs, credits, storage, moderation, Providers, payments, and administration. Brand,
origins, and support details are deployment configuration rather than hardcoded production
identity.

The repository is production-oriented, but a checkout is not live-certified until its own cloud
accounts, credentials, quotas, Webhooks, alerts, and staging load have been verified. See the
[EzPic product contract](docs/product/ezpic-product-contract.md) for the exact public/internal
boundary and PR 1 exclusions.

## Authenticated editor workflow

The `/create` workspace restores an eligible claimed draft, prior job, or owned asset; requires an
owned, READY private source image and a non-empty prompt; and exposes only Standard Edit and Quality
Edit. Review creates a server-side quote without reserving credits. Explicit confirmation uses one
stable idempotency key to atomically create the existing job, input binding, credit reservation, and
Outbox event.

The result panel follows the job across refreshes, presents safe success, failure, moderation,
cancellation, and credit-settlement states, and compares the job-bound input with only an approved
output. Previews and downloads use short-lived owner-authorized URLs. A recovered Quality draft
safely falls back to Standard when the active plan lacks that entitlement while retaining its image
and prompt.

The first confirmed edit also creates a lightweight private edit session inside that same job,
input-binding, reservation, and Outbox transaction. `/edits` lists the signed-in user's sessions,
and `/edits/[sessionId]` shows an auditable version timeline. **Edit Again** can branch from any
eligible successful version, but every branch creates a fresh server-side quote, moderation
decision, reservation, idempotency key, job, and Outbox event; it never reuses the earlier job's
financial or safety decisions. The selected parent/session is frozen into that quote by the server;
confirmation cannot omit, inject, or replace the quoted edit relationship.
Retrying a failed version also creates a fresh quote, moderation decision, reservation, job, and
Outbox event while preserving the original session and branch; durable retry recovery rejects a
result that lost that private binding.

## Inherited foundation capabilities

- **Stable product catalog and Provider abstraction:** clients submit public product keys and validated parameters; server-only routes moderate prompts and map approved requests to Replicate, Fal, Kie, or Gemini adapters. Provider names, model IDs, credentials, raw errors, and arbitrary result URLs stay off the public contract.
- **Durable background work:** PostgreSQL is the only business source of truth. Job creation, input binding, credit reservation, and the initial Outbox event commit atomically. Trigger.dev is the first-release task engine, while polling, Webhooks, and reconciliation recover work from persisted state.
- **Auditable credits and subscriptions:** immutable ledger entries, expiring credit lots, atomic reservation/charge/release, zero charge when no usable output exists, monthly grants for monthly and annual Stripe plans, cancellation, refunds, and refund debt are modeled explicitly.
- **Private media pipeline:** direct single-part or multipart upload, aggregate per-owner storage and active-session quotas, exact part constraints, signed reads, streamed Provider transfer, moderation, quarantine, soft delete, and durable object cleanup avoid buffering large videos through Vercel.
- **Reusable product surfaces:** authenticated creator, private edit-session/version history, job history/detail and asset library, plus an anonymous marketing draft handoff that transfers only after sign-in and one-time claim.
- **Operational controls:** generation, moderation, billing, Provider/model and queue gates; redacted structured logs; Sentry hooks; protected diagnostics, replay, stage retry and uncertain-submission resolution; CI, Provider smoke budgets, load profiles, and invariant verification.

## Local development

Requirements: Node.js 22+, pnpm 11, Docker, and PostgreSQL. Copy `.env.local.example` to `.env.local`, keep mock/test adapters enabled locally, then run:

```bash
docker compose up -d
pnpm install --frozen-lockfile
pnpm db:migrate:deploy
pnpm dev
```

The SaaS app is at `http://localhost:3000`; marketing is at `http://localhost:3001`. Media objects use the private `MEDIA_BUCKET_NAME` bucket (`media-private` locally). Do not use the legacy `S3_BUCKET` variable.

## Verification

```bash
pnpm lint --deny-warnings
pnpm format:check
pnpm type-check
pnpm test:unit:contracts
pnpm test:integration
pnpm e2e:media:ci
pnpm verify:invariants
```

PostgreSQL integration commands require an explicit loopback `TEST_DATABASE_URL` whose database name contains `test` or `testing`; they never fall back to `DATABASE_URL`. Mock E2E fails when its database, test user, Chromium, or test adapters are missing.

The current local production-build browser suite passes 11 SaaS checks and five marketing checks
with no skips. SaaS coverage includes a root edit, a second edit, and a branch from the older
successful version. It uses deterministic test Provider and moderation adapters, an isolated
PostgreSQL database, and private local MinIO; this is evidence for the application workflow, not
for external Provider or cloud connectivity. The production dependency audit currently has no
high or critical advisories; low and moderate advisories remain subject to normal dependency
maintenance.

Load profiles are `smoke`, `steady` (200 jobs/min for 30 minutes), `peak` (400 jobs/min for five minutes), and `active-1000`. Remote targets require both `ALLOW_REMOTE_LOAD_TARGET=true` and an exact `LOAD_TARGET_CONFIRMATION` origin.

```bash
pnpm load:media
pnpm verify:invariants
```

The guarded local route smoke is implemented and has passed against the isolated test database; its post-run invariant checks remained at zero violations. This workstation does not have k6 installed, so no real k6 result is claimed. The five-minute peak, 30-minute steady, and active-1000 profiles still require a dedicated staging-equivalent deployment and have not been certified from this checkout.

Real Provider smoke tests are excluded from PR CI. The protected `Provider smoke` workflow validates its configured route allowlist, maximum invocation count, and maximum expected cost before a Provider call; no image-edit certification or live result is implied by local mocks or a dry run.

The image-edit benchmark command is safe by default:

```bash
pnpm provider:benchmark:image-edit
```

It reads the committed placeholder manifest, plans 30 edit tasks across the current internal route
candidates, and reports every real quality, latency, cost, success, and routing decision as
`NOT_COMPLETED`. It does not call a Provider. Live execution additionally requires `--live`,
`--confirm-spend`, a positive `--max-budget-micros`, an authorized private manifest, the selected
Provider credentials, and an executor bound to the existing private generation, remote-URL policy,
storage, and moderation path. See
[the benchmark report](docs/product/image-edit-model-benchmark.md); the existing routes are not
claimed as image-edit-certified.

Before calling a deployment live-ready, record successful staging checks for Trigger.dev task deployment, Stripe test-mode Webhook delivery, every enabled Provider route, Sightengine, private S3/R2 multipart and streamed transfer, Sentry ingestion/alerts, and the documented staging load profiles.

## Operations

Use [docs/operations/ai-media-runbook.md](docs/operations/ai-media-runbook.md) for production accounts, environment validation, migration safety, Trigger deployment, storage IAM/CORS, Stripe Webhooks, moderation, Sentry, model certification, load verification, replay/reconciliation, refunds, backup/restore, rollback, secret rotation, and incident response.
