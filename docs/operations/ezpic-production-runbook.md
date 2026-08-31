# EzPic production launch runbook

## Certification boundary

This runbook prepares EzPic for a controlled launch; it does not authorize or perform deployment.
Production must **fail closed** whenever a required integration, kill switch, daily cost budget,
alert, environment identity, or evidence record is absent. PostgreSQL remains the business source of
truth. Trigger.dev, AI Providers, private S3/R2, the moderation service, Stripe, Sentry, PostHog,
Google Search Console (GSC), and the mail Provider are delivery or observation systems, never a
second job, credit, storage, payment, or analytics state store.

No credential, token, cookie, signed URL, raw Provider payload, prompt, or private object key belongs
in this runbook or its evidence files. Record only non-secret environment/project names, origins,
resource identifiers, deployment revisions, timestamps, redacted artifact references, aggregate
counts, and operator approvals.

The committed evidence template intentionally remains `NOT_COMPLETED`. Local tests, mock adapters,
MinIO, a local PostgreSQL database, dry-run benchmark output, and production builds do not certify a
real external service.

## Required isolated environments

Maintain one resource set for each of `development`, `test`, `staging`, and `production`. Replace the
values in `evidence/ezpic-environment-matrix.template.json` in a protected release artifact; do not
commit account-specific identifiers merely to make the template pass.

The matrix must prove that all four environments use distinct:

- environment identities and PostgreSQL databases;
- private media buckets and least-privilege storage identities;
- Stripe accounts/modes or Webhook scopes and Webhook verification material;
- Trigger.dev environments;
- PostHog projects, Sentry environments, and mail Provider scopes.

Staging and production run with `NODE_ENV=production`. Production rejects mock Provider routing,
test moderation, browser E2E adapters, the guarded load endpoint, anonymous draft E2E handoff, and
the legacy unmetered stream. Secrets stay only in the hosting platform and worker secret manager.

## Non-secret external inventory

| Boundary               | Record before certification                                                                                                                  | Current status  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| PostgreSQL             | Environment name, database resource ID, PostgreSQL version, migration revision, backup and isolated restore artifact                         | `NOT_COMPLETED` |
| Trigger.dev Cloud      | Project/environment name, deployed task revision, queue list, redacted run and replay references                                             | `NOT_COMPLETED` |
| Private S3/R2          | HTTPS endpoint origin, bucket resource ID, region, IAM policy review, CORS/lifecycle version, multipart and signed-URL evidence              | `NOT_COMPLETED` |
| Standard Edit Provider | Internal route certification reference, Provider endpoint/model identifier kept server-side, billed cost, p50/p95, failure/recovery evidence | `NOT_COMPLETED` |
| Quality Edit Provider  | Separate route certification reference, billed cost, p50/p95, moderation and rollback evidence                                               | `NOT_COMPLETED` |
| Moderation             | Service environment name, policy/rule versions, prompt/input/output result references, alert and failure evidence                            | `NOT_COMPLETED` |
| Stripe                 | Test/live scope names, Product/Price evidence, Webhook endpoint name, lifecycle and reconciliation artifacts                                 | `NOT_COMPLETED` |
| Sentry                 | Project/environment name, release, alert rule IDs and destination receipt                                                                    | `NOT_COMPLETED` |
| PostHog and GSC        | Project/property identifiers, consent evidence, ingestion references, domain verification and sitemap submission                             | `NOT_COMPLETED` |
| Mail Provider          | Provider/environment name, verified sender domain, delivery and bounce references                                                            | `NOT_COMPLETED` |

## Configuration and preflight

Start from `.env.local.example`; populate the target only through its protected environment manager.
The deploy-time contract checks secret-bearing variables for presence but never returns their values.
It also requires real credential-free HTTPS origins, non-placeholder deployment/resource IDs, genuine
server-side Stripe Price IDs, a configured GSC property, PostHog project, mail sender, kill switches,
daily Provider budget, and alert thresholds.

Run offline structure validation from a checkout of the exact candidate revision:

```bash
pnpm launch:evidence:validate
pnpm load:ezpic:syntax
pnpm load:type-check
```

The first command should print `NOT_COMPLETED` while the committed templates are in use. In a
protected release job, point `EZPIC_ENVIRONMENT_MATRIX_PATH` and `EZPIC_LAUNCH_EVIDENCE_PATH` to the
approved artifacts, then run:

```bash
pnpm launch:certify
```

Any missing or mismatched deployment revision, any incomplete staging scenario, a placeholder
resource, or an invalid production variable must make that command fail. `/api/ready` runs the same
launch contract in production mode and returns 503 on failure; only an authenticated administrator
may receive the bounded check names and a generic failure label. Dependency messages and inferred
environment identifiers are never returned.

## Controlled release sequence

1. Freeze the candidate revision. Record its full commit SHA and confirm CI, migrations, unit/API/
   database/jobs tests, invariants, production builds, and applicable production-build Playwright.
2. Take a restorable PostgreSQL backup and restore it into an isolated target. Record versions,
   checksum reference, start/end time, and restore verification. Never test restore against production.
3. Deploy the candidate to isolated staging with new generation and paid checkout disabled. Deploy
   the matching Trigger.dev task revision; workers do not run migrations.
4. Verify `/api/health`, `/api/ready`, database migration state, private bucket access, task
   registration, Webhook verification, reconciliation, cleanup, and alert delivery.
5. Execute all 20 staging scenarios in `evidence/ezpic-staging-evidence.json`. Replace a scenario with
   `PASS` only when its evidence refers to the exact deployed revision and target environment.
6. Run the existing Provider smoke and image-edit benchmark through their bounded, explicitly
   authorized modes. A dry run stays `NOT_COMPLETED`; real edits must continue through quote,
   moderation, reservation, GenerationJob, Outbox, private storage, Provider routing, finalization,
   output moderation, and idempotent settlement.
7. Run the six-surface k6 plan. `pnpm load:ezpic` is dry-run only. Actual execution additionally needs
   `--execute` through `pnpm load:ezpic:execute`, exact `LOAD_EXECUTION_CONFIRMATION`, request/error/P95
   budgets, and zero Provider budget unless bounded staging Provider calls were separately confirmed.
   A remote target must be HTTPS, allowlisted, exactly confirmed for the unified product origin,
   and identified twice as staging. Production is never an allowed remote load identity.
8. Validate measured successful-edit cost, full-use Creator/Studio cost, and approved margin using
   `../product/ezpic-final-cost-model.md`. Catalog `providerCostMicros` values are reservation ceilings,
   not billed production evidence.
9. Obtain release, privacy, billing, and incident-response approval. Run `pnpm launch:certify` against
   the protected artifacts. Do not proceed unless it returns `PASS`.
10. Deploy production with `MEDIA_GENERATION_ENABLED=false`, `MEDIA_STANDARD_EDIT_ENABLED=false`, and
    `MEDIA_QUALITY_EDIT_ENABLED=false`. Verify readiness, migrations, task revision, storage metadata,
    Webhook endpoints, observability, canonical/sitemap/robots, SSL, and DNS before enabling traffic.
11. Enable Standard Edit first with a conservative traffic cohort and daily Provider cost budget.
    Quality Edit has a separate flag and stays off until its independent evidence and approval pass.

Guest real generation remains disabled. Public names are Standard Edit and Quality Edit; internal
keys remain `image-fast` and `image-quality`. Video products remain outside the EzPic public catalog,
plans, navigation, SEO, and UI.

## Kill switches and cost admission

New work requires all applicable layers to allow it:

- `MEDIA_GENERATION_ENABLED=true` and no active `media.generation.enabled=false` runtime override;
- `MEDIA_STANDARD_EDIT_ENABLED=true` for Standard Edit;
- `MEDIA_QUALITY_EDIT_ENABLED=true` for Quality Edit, which also requires Standard enabled;
- no active `media.model.image-fast.enabled=false` or `media.model.image-quality.enabled=false`
  runtime override;
- a positive `MEDIA_DAILY_PROVIDER_COST_BUDGET_MICROS`.

The API checks the global UTC-day spend prospectively, and the job-creation transaction takes a
global day-scoped PostgreSQL advisory lock before summing frozen Quote cost and reserving credits.
Concurrent users therefore cannot jointly cross the configured ceiling. An idempotent replay does
not consume the budget twice. Budget exhaustion rejects new jobs; it does not rewrite existing jobs,
release an uncertain Provider acceptance, or bypass normal recovery.

## Analytics, search, and privacy gate

PostHog delivery requires explicit analytics consent and a `sha256:` anonymous session identifier.
Marketing hands the anonymous identifier to SaaS in a POST body only; it is never placed in a URL.
The browser sender omits credentials and rejects prompts, email addresses, private IDs, URLs, object
keys, Provider/model/cost data, and other sensitive properties. A local browser fixture proves only
the application contract. Record real Marketing and SaaS ingestion events in the same PostHog
project before marking the funnel `PASS`.

Separately verify the exact production canonical origin, four-URL sitemap, robots behavior, GSC
domain property, verification token, sitemap submission, and live crawl evidence. Placeholder origins
or an absent GSC/PostHog configuration fail closed.

## Alerts and 24–72 hour watch

Before Standard traffic, prove alert delivery for the configured error-rate, p95 latency, and
moderation-rejection thresholds. Also monitor Provider failures, uncertain submissions, queue delay,
Outbox pending/dead-letter age, transfer/finalization failures, reconciliation repairs, storage
cleanup, payment events, credit invariants, global daily Provider cost, consented funnel delivery,
and checkout conversion.

For the first **24–72 hours**:

- record traffic cohort and configuration revision at every change;
- compare Quote cost, Provider-reported/billed cost, settled credits, success rate, and p50/p95;
- review Sentry, Trigger.dev, Provider, moderation, Stripe, storage, PostHog, and mail dashboards;
- stop expansion on any unexplained financial, privacy, idempotency, moderation, or data-integrity
  deviation;
- expand only Standard traffic in small steps; enable Quality separately after its own review;
- attach a redacted daily snapshot and operator decision to the launch record.

Follow `ezpic-rollback.md` on a threshold breach. Use `ai-media-runbook.md` for detailed replay,
reconciliation, refund/Debt, storage cleanup, backup/restore, secret rotation, and incident procedures.
