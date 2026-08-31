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
output. Previews and downloads use short-lived owner-authorized URLs. When the current plan does not
include Quality Edit, the editor keeps the private source image, prompt, Quality selection, and edit
session context and opens the plan comparison; it never silently submits a Standard Edit instead.

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

## Plans and subscription safety

`PLAN_ENTITLEMENTS` is the single source for the pricing UI and runtime product, concurrency, and
input-size authorization:

| Plan    | Monthly credits | Concurrent edits | Products                       | Max input | Price                |
| ------- | --------------: | ---------------: | ------------------------------ | --------: | -------------------- |
| Free    |              25 |                1 | Standard Edit                  |     10 MB | $0                   |
| Creator |           1,000 |                3 | Standard Edit and Quality Edit |     20 MB | $19/month, $190/year |
| Studio  |           5,000 |               10 | Standard Edit and Quality Edit |     20 MB | $79/month, $790/year |

Free credits are granted only by the server through the existing immutable Credit Account, Lot,
and Ledger path, once per UTC calendar month with a stable reference key. An ACTIVE paid
subscription or a PAST_DUE subscription whose grace period is still valid suppresses the Free
grant. Monthly and annual paid subscriptions continue to use the existing internal monthly credit
periods, Webhook idempotency, refund, Debt, and failed-job settlement semantics.

Stripe Price identifiers are never hardcoded. Creator and Studio checkout requires valid
server-only `PRICE_ID_CREATOR_MONTHLY`, `PRICE_ID_CREATOR_YEARLY`,
`PRICE_ID_STUDIO_MONTHLY`, and `PRICE_ID_STUDIO_YEARLY` values. Missing or malformed values fail
closed with a visible temporary-unavailability message before Stripe is called. The matching active
`BillingPlan` snapshot must also agree with the canonical plan identity, monthly credits, interval
price, and currency or checkout remains unavailable. Checkout return
only polls server-owned Webhook state; it grants no credits and restores the saved editor context
only after the requested paid plan is ACTIVE or still inside its server-recorded PAST_DUE grace.
The existing owner-authorized Customer Portal remains the place to manage cancellation and payment
methods.

Authenticated customers can choose only payment methods advertised by the server for the selected
plan and interval. PayPal and Waffo Pancake require complete server-only credentials, provider plan
or product IDs, and matching active `BillingPlan` snapshots; the browser submits only the stable
provider name, plan, interval, and idempotency key. Stripe keeps its owner-authorized portal, while
providers without a private billing portal expose only the owner-authorized cancellation action they
declare. All providers share `/api/webhooks/payments`, persisted `PaymentEvent`/Outbox delivery, and
the immutable credit lifecycle. Real PayPal and Waffo sandbox certification remains
`NOT_COMPLETED` until deployment credentials and dashboard evidence are available.

See [the pricing and margin record](docs/product/ezpic-pricing-and-margin.md) for the cost formula,
configuration boundary, rollback, and external items that remain `NOT_COMPLETED`.

## SEO, consented growth, and operations

The unified public `/` route is indexable and owns the canonical and sitemap entry. Login, guest
workspace, creator, history, assets, checkout, settings, and admin routes remain
`noindex, nofollow`. The legacy `NEXT_PUBLIC_MARKETING_URL` setting is a compatibility alias and
must match `NEXT_PUBLIC_SAAS_URL` in production.

The 18-step editing funnel uses one shared strict event schema and the existing cookie-consent
choice. It rejects prompts, filenames, private/signed URLs, raw job or asset IDs, email, tokens,
Provider/model/cost data, and raw responses before transport. The browser keeps the local
`ezpic:growth-event` fixture and, only with consent and complete production configuration, sends the
same minimized event to PostHog under a `sha256:` anonymous session identifier. The public landing
passes that identifier through a same-origin POST rather than a URL. Real external ingestion is still
`NOT_COMPLETED`. Admins receive read-only aggregate media operations—success, latency, Provider cost,
moderation, failure, credit settlement, repeat-edit, route, and kill-switch state—through the
existing admin-only oRPC and PostgreSQL boundaries.

See [the growth, SEO, and operations contract](docs/product/ezpic-growth-operations.md) for the
index matrix, complete event list, metrics definitions, rollback, and external `NOT_COMPLETED`
items.

## Production launch certification

PR 8 adds fail-closed staging/production configuration, independent Standard and Quality launch
flags, an atomic global UTC-day Provider cost ceiling, production readiness integration, an offline
evidence validator, and a guarded six-surface k6 plan. It prepares a launch but does not deploy one.

```bash
pnpm launch:evidence:validate
pnpm load:ezpic:syntax
pnpm load:type-check
pnpm load:ezpic
```

The committed environment matrix and 20-scenario staging record intentionally produce
`NOT_COMPLETED`. A protected release job may point to approved external evidence and run
`pnpm launch:certify`; the command fails unless the exact deployment revision, every staging
scenario, all isolated resource identifiers, kill switches, budgets, alerts, and external service
contracts pass. `pnpm load:ezpic` only prints a bounded plan. Actual k6 execution additionally needs
an exact run confirmation, and remote targets must be HTTPS, allowlisted, single-origin-confirmed,
and identified as staging.

See the [production runbook](docs/operations/ezpic-production-runbook.md),
[launch checklist](docs/operations/ezpic-launch-checklist.md),
[rollback procedure](docs/operations/ezpic-rollback.md), and
[final cost model](docs/product/ezpic-final-cost-model.md). Real PostgreSQL, Trigger.dev, private
S3/R2, Provider, moderation, Stripe, Sentry, PostHog/GSC, mail, deployment, DNS/SSL, alert arrival,
load, cost, and rollback evidence remains separately `NOT_COMPLETED`.

## Inherited foundation capabilities

- **Stable product catalog and Provider abstraction:** clients submit public product keys and validated parameters; server-only routes moderate prompts and map approved requests to Replicate, Fal, Kie, or Gemini adapters. Provider names, model IDs, credentials, raw errors, and arbitrary result URLs stay off the public contract.
- **Durable background work:** PostgreSQL is the only business source of truth. Job creation, input binding, credit reservation, and the initial Outbox event commit atomically. Trigger.dev is the first-release task engine, while polling, Webhooks, and reconciliation recover work from persisted state.
- **Auditable credits and subscriptions:** immutable ledger entries, expiring credit lots, atomic reservation/charge/release, zero charge when no usable output exists, monthly grants for monthly and annual Stripe plans, cancellation, refunds, and refund debt are modeled explicitly.
- **Private media pipeline:** direct single-part or multipart upload, aggregate per-owner storage and active-session quotas, exact part constraints, signed reads, streamed Provider transfer, moderation, quarantine, soft delete, and durable object cleanup avoid buffering large videos through Vercel.
- **Reusable product surfaces:** an upload-first public landing page, temporary anonymous Standard workspace, authenticated creator, private edit-session/version history, job history/detail, and asset library, all on one SaaS origin.
- **Operational controls:** generation, moderation, billing, Provider/model and queue gates; redacted structured logs; Sentry hooks; protected diagnostics, replay, stage retry and uncertain-submission resolution; CI, Provider smoke budgets, load profiles, and invariant verification.

## Local development

Requirements: Node.js 22+, pnpm 11, Docker, and PostgreSQL. Copy `.env.local.example` to `.env.local`, keep mock/test adapters enabled locally, then run:

```bash
docker compose up -d
pnpm install --frozen-lockfile
pnpm db:migrate:deploy
pnpm dev
```

The complete product is at `http://localhost:3000`: `/` is the public upload-first tool and
authenticated features stay in the same SaaS application. Port 3001 is not started. Media objects
use the private `MEDIA_BUCKET_NAME` bucket (`media-private` locally). Do not use the legacy
`S3_BUCKET` variable.

## Verification

```bash
pnpm lint --deny-warnings
pnpm format:check
pnpm type-check
pnpm test:unit:contracts
pnpm test:integration
pnpm e2e:media:ci
pnpm verify:invariants
pnpm launch:evidence:validate
pnpm load:ezpic:syntax
pnpm load:type-check
```

PostgreSQL integration commands require an explicit loopback `TEST_DATABASE_URL` whose database name contains `test` or `testing`; they never fall back to `DATABASE_URL`. Mock E2E fails when its database, test user, Chromium, or test adapters are missing.

The local production-build browser harness covers the public landing and same-origin guest handoff,
authenticated editing lifecycle, private edit sessions and branching, insufficient credits,
Free-to-paid upgrade recovery, checkout return, and the public SEO/canonical/sitemap boundary. It
uses deterministic test Provider and moderation adapters, an
isolated PostgreSQL database, and private local MinIO; this is evidence for the application workflow,
not for Stripe, Provider, Trigger.dev, moderation, or cloud-storage connectivity. The production
dependency audit currently has no high or critical advisories; low and moderate advisories remain
subject to normal dependency maintenance.

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
