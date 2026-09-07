# EzPic production launch runbook

## Certification boundary

This runbook prepares EzPic for a controlled launch; it does not authorize or perform deployment.
Production must **fail closed** whenever a required integration, kill switch, daily cost budget,
alert, environment identity, or evidence record is absent. PostgreSQL remains the business source of
truth. Trigger.dev, AI Providers, private S3/R2, the moderation service, PayPal, Waffo, optional
legacy Stripe maintenance, Sentry, PostHog, Google Search Console (GSC), and the mail Provider are
delivery or observation systems, never a second job, credit, storage, payment, or analytics state
store.

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
- PayPal and Waffo accounts/modes and Webhook verification material;
- optional legacy Stripe Webhook scopes only in environments that maintain historical subscriptions;
- Trigger.dev environments;
- PostHog projects, Sentry environments, and mail Provider scopes.

Staging and production run with `NODE_ENV=production`. Production rejects mock Provider routing,
test moderation, browser E2E adapters, the guarded load endpoint, anonymous draft E2E handoff, and
the legacy unmetered stream. Secrets stay only in the hosting platform and worker secret manager.

## Non-secret external inventory

| Boundary                | Record before certification                                                                                                                      | Current status  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| PostgreSQL              | Environment name, database resource ID, PostgreSQL version, migration revision, backup and isolated restore artifact                             | `NOT_COMPLETED` |
| Trigger.dev Cloud       | Project/environment name, deployed Kie task revision, queue list, redacted run and replay references                                             | `NOT_COMPLETED` |
| Private S3/R2           | HTTPS endpoint origin, bucket resource ID, region, IAM policy review, CORS/lifecycle version, multipart and signed-URL evidence                  | `NOT_COMPLETED` |
| Kie Nano Banana 2 Lite  | `nano-banana-2-lite-1k` paid run, billed cost, output host/MIME/dimensions, p50/p95, failure/recovery and rollback evidence                      | `NOT_COMPLETED` |
| Kie Nano Banana         | `nano-banana-default` paid run with the same complete evidence set                                                                               | `NOT_COMPLETED` |
| Kie Nano Banana 2       | Separate 1K, 2K, and 4K SKU artifacts with the same complete evidence set                                                                        | `NOT_COMPLETED` |
| Kie Nano Banana Pro     | Separate 1K, 2K, and 4K SKU artifacts with the same complete evidence set                                                                        | `NOT_COMPLETED` |
| Kie GPT Image 1.5       | Separate Medium and High SKU artifacts with the same complete evidence set                                                                       | `NOT_COMPLETED` |
| Kie GPT Image 2         | Separate 1K, 2K, and 4K SKU artifacts with the same complete evidence set                                                                        | `NOT_COMPLETED` |
| Kie Seedream 4.5        | Separate Basic 2K and High 4K SKU artifacts with the same complete evidence set                                                                  | `NOT_COMPLETED` |
| Kie Seedream 5 Lite     | Separate Basic 2K, High 3K, and Ultra 4K SKU artifacts with the same complete evidence set                                                       | `NOT_COMPLETED` |
| Kie Seedream 5 Pro      | Separate Basic 1K and High 2K SKU artifacts with the same complete evidence set                                                                  | `NOT_COMPLETED` |
| Legacy OpenRouter drain | Backlog count, recovery-only configuration, credential/certification status, same-attempt reconciliation, zero new submissions, retirement owner | `NOT_COMPLETED` |
| Moderation              | Service environment name, policy/rule versions, prompt/input/output result references, alert and failure evidence                                | `NOT_COMPLETED` |
| PayPal                  | Sandbox/live scope, Pro/Ultimate/Max plan IDs, all four Credit Pack product IDs, Webhook, lifecycle and reconciliation artifacts                 | `NOT_COMPLETED` |
| Waffo                   | Test/prod store and merchant scopes, Pro/Ultimate/Max and all four Credit Pack product IDs, Webhook, lifecycle and reconciliation artifacts      | `NOT_COMPLETED` |
| Sentry                  | Project/environment name, release, alert rule IDs and destination receipt                                                                        | `NOT_COMPLETED` |
| PostHog and GSC         | Project/property identifiers, consent evidence, ingestion references, domain verification and sitemap submission                                 | `NOT_COMPLETED` |
| Mail Provider           | Provider/environment name, verified sender domain, delivery and bounce references                                                                | `NOT_COMPLETED` |

## Configuration and preflight

Start from `.env.local.example`; populate the target only through its protected environment manager.
The deploy-time contract checks secret-bearing variables for presence but never returns their values.
It also requires real credential-free HTTPS origins, non-placeholder deployment/resource IDs, at
least one complete PayPal or Waffo checkout configuration, a configured GSC property, PostHog
project, mail sender, kill switches, daily Provider budget, and alert thresholds. Stripe is omitted
when both lifecycle secrets are absent. Exactly one Stripe secret fails closed; a complete pair
activates historical lifecycle maintenance and requires its isolated Webhook scope. Stripe Price IDs
remain optional legacy metadata and never enable new checkout.

For new images, configure `MEDIA_ENABLED_PROVIDERS=kie` and provide `KIE_API_KEY` only to the
server/worker boundary that submits or retrieves tasks. Set
`MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS` to a comma-separated list that includes the exact active
catalog version only after all 20 SKU cells are certified. Add a hostname to `KIE_OUTPUT_HOSTS`
only after it is observed and approved; real paid confirmation of every Kie result host is still
`NOT_COMPLETED`. If legacy OpenRouter work remains, list `openrouter` only under
`MEDIA_RECOVERY_PROVIDERS`; the current launch validator also requires its recovery credential and
`MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED=true` while that path is configured.

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
6. Validate all 20 current Kie product/SKU smoke entries. A dry run proves only route/SKU/budget
   configuration and stays `NOT_COMPLETED`. A paid smoke is valid only when it continues through
   quote, moderation, reservation, GenerationJob, Outbox, private storage, Kie submission and
   polling, finalization, output moderation, and idempotent settlement. The retired OpenRouter
   `image-edit-model-benchmark.md` is legacy history and cannot be attached as Kie evidence.
7. Run the six-surface k6 plan. `pnpm load:ezpic` is dry-run only. Actual execution additionally needs
   `--execute` through `pnpm load:ezpic:execute`, exact `LOAD_EXECUTION_CONFIRMATION`, request/error/P95
   budgets, and zero Provider budget unless bounded staging Provider calls were separately confirmed.
   A remote target must be HTTPS, allowlisted, exactly confirmed for the unified product origin,
   and identified twice as staging. Production is never an allowed remote load identity.
8. Validate measured successful-edit cost, full-use Pro/Ultimate/Max and Credit Pack cost, and
   approved margin using `../product/ezpic-final-cost-model.md`. Verify all four Credit Packs grant
   their exact base credits, freeze the active-subscriber decision, grant exactly +20% when eligible,
   and expire after six UTC calendar months. Catalog `providerCostMicros` values are reservation
   ceilings, not billed production evidence.
9. Obtain release, privacy, billing, and incident-response approval. Run `pnpm launch:certify` against
   the protected artifacts. Do not proceed unless it returns `PASS`.
10. Deploy production with `MEDIA_GENERATION_ENABLED=false` and all nine product gates false:
    `MEDIA_NANO_BANANA_2_LITE_ENABLED`, `MEDIA_NANO_BANANA_ENABLED`,
    `MEDIA_NANO_BANANA_2_ENABLED`, `MEDIA_NANO_BANANA_PRO_ENABLED`,
    `MEDIA_GPT_IMAGE_1_5_ENABLED`, `MEDIA_GPT_IMAGE_2_ENABLED`,
    `MEDIA_SEEDREAM_4_5_ENABLED`, `MEDIA_SEEDREAM_5_LITE_ENABLED`, and
    `MEDIA_SEEDREAM_5_PRO_ENABLED`. Put `kie` in `MEDIA_ENABLED_PROVIDERS`; keep OpenRouter out of
    that list. If an already-accepted legacy backlog exists, put OpenRouter only in
    `MEDIA_RECOVERY_PROVIDERS` and retain its worker-only recovery credential/gate. Verify readiness,
    migrations, task revision, storage metadata, Webhook endpoints, observability,
    canonical/sitemap/robots, SSL, and DNS before enabling traffic.
11. After all 20 exact SKU artifacts are approved and active catalog version `2026-09-07.2` is
    present in `MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS`, enable Nano Banana 2 Lite for a small
    cohort. Enable each of the other eight products independently only after every SKU under that
    product has its own evidence and rollback owner.

Guest real generation remains disabled until the separate anonymous-trial gate passes. When enabled,
it is fixed to Nano Banana 2 Lite 1K at five sponsored EzPic Credits. Paid plans share one EzPic
Credit balance across all nine public products and 20 legal SKU cells. Output format and background
are non-billable controls and do not create extra SKU cells. Video products remain outside
the EzPic public catalog, plans, navigation, SEO, and UI.

## Kill switches and cost admission

New work requires all applicable layers to allow it:

- `MEDIA_GENERATION_ENABLED=true` and no active `media.generation.enabled=false` runtime override;
- the selected product's matching environment gate is true: one of
  `MEDIA_NANO_BANANA_2_LITE_ENABLED`, `MEDIA_NANO_BANANA_ENABLED`,
  `MEDIA_NANO_BANANA_2_ENABLED`, `MEDIA_NANO_BANANA_PRO_ENABLED`,
  `MEDIA_GPT_IMAGE_1_5_ENABLED`, `MEDIA_GPT_IMAGE_2_ENABLED`,
  `MEDIA_SEEDREAM_4_5_ENABLED`, `MEDIA_SEEDREAM_5_LITE_ENABLED`, or
  `MEDIA_SEEDREAM_5_PRO_ENABLED`;
- no active `media.model.<selected-product-key>.enabled=false` runtime override for the selected
  product;
- `kie` in `MEDIA_ENABLED_PROVIDERS`, `KIE_API_KEY` in the worker environment, and active catalog
  version `2026-09-07.2` in `MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS`;
- a positive `MEDIA_DAILY_PROVIDER_COST_BUDGET_MICROS`.

The API checks the global UTC-day spend prospectively, and the job-creation transaction takes a
global day-scoped PostgreSQL advisory lock before summing frozen Quote cost and reserving credits.
Concurrent users therefore cannot jointly cross the configured ceiling. An idempotent replay does
not consume the budget twice. Budget exhaustion rejects new jobs; it does not rewrite existing jobs,
release an uncertain Provider acceptance, or bypass normal recovery.

## Analytics, search, and privacy gate

PostHog delivery requires explicit analytics consent and a `sha256:` anonymous session identifier.
The Landing and authenticated product surfaces share that anonymous identifier within the unified
SaaS origin; it is never placed in a URL. The browser sender omits credentials and rejects prompts,
email addresses, private IDs, URLs, object keys, Provider/model/cost data, and other sensitive
properties. A local browser fixture proves only the application contract. Record real Landing and
authenticated SaaS ingestion events in the same PostHog project before marking the funnel `PASS`.

Separately verify the exact production canonical origin, four-URL sitemap, robots behavior, GSC
domain property, verification token, sitemap submission, and live crawl evidence. Placeholder origins
or an absent GSC/PostHog configuration fail closed.

## Alerts and 24–72 hour watch

Before Kie image traffic, prove alert delivery for the configured error-rate, p95 latency, and
moderation-rejection thresholds. Also monitor Provider failures, uncertain submissions, queue delay,
Outbox pending/dead-letter age, transfer/finalization failures, reconciliation repairs, storage
cleanup, payment events, credit invariants, global daily Provider cost, consented funnel delivery,
and checkout conversion.

For the first **24–72 hours**:

- record traffic cohort and configuration revision at every change;
- compare Quote cost, Provider-reported/billed cost, settled credits, success rate, and p50/p95;
- review Sentry, Trigger.dev, AI Provider, moderation, PayPal/Waffo, storage, PostHog, and mail
  dashboards; review Stripe only where legacy lifecycle maintenance is enabled;
- stop expansion on any unexplained financial, privacy, idempotency, moderation, or data-integrity
  deviation;
- expand each product in small steps and never use one model's evidence to enable another model or
  untested resolution/quality SKU;
- attach a redacted daily snapshot and operator decision to the launch record.

Follow `ezpic-rollback.md` on a threshold breach. Use `ai-media-runbook.md` for detailed replay,
reconciliation, refund/Debt, storage cleanup, backup/restore, secret rotation, and incident procedures.
