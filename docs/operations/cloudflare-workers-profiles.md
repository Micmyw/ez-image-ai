# Workers and hybrid deployment profiles

`EZPIC_DEPLOYMENT_PROFILE=workers` is the default prepared deployment. The website uses
OpenNext on Workers, Workflows orchestrates tasks, and a private Durable Object executes the
existing jobs handlers with Cloudflare Images. This profile has no Container resource.

The production cutover completed on September 11, 2026. See
[current production status](cloudflare-production-status.md) and the
[deployment evidence](evidence/cloudflare-workers-deployment-2026-09-11.md) for the active
versions and verification limits at cutover. The operator enabled PayPal Sandbox and Waffo Test
on the existing production Workers on September 12. Use `.env.production.local` and the active
Worker deployment to confirm current controls before changing billing to live collection.

If a payment provider cannot reach the custom domain, `PAYMENT_WEBHOOK_INGRESS_ORIGIN` may name
the same website Worker's exact HTTPS `workers.dev` origin. Preparation enables that address;
only `POST /api/webhooks/payments` is forwarded to the existing verifier. Other routes stay closed.

`EZPIC_DEPLOYMENT_PROFILE=hybrid` keeps the same Workers website and moves background execution
to the existing jobs Container with Sharp. Both profiles use PostgreSQL as business truth and
private R2 for assets. No schema migration was added by this runtime change.

| Boundary            | workers                             | hybrid                                             |
| ------------------- | ----------------------------------- | -------------------------------------------------- |
| Website             | Workers + OpenNext + Images         | Workers + OpenNext + Images                        |
| Jobs                | WorkerJobs Durable Object + Images  | JobsContainer + Sharp                              |
| Orchestration       | Workflows                           | Workflows                                          |
| Database access     | Request-owned Prisma via Hyperdrive | Hyperdrive for website; direct PostgreSQL for jobs |
| Default preparation | No Docker build                     | Docker required for jobs build                     |

## Configuration and preparation

For Cloudflare Git builds triggered by `main` pushes, use the
[automatic production deployment configuration](cloudflare-automatic-deployment.md). It connects
the existing website and jobs Workers to the same repository and production branch.

Keep target values in ignored `.env.production.local` or `.env.staging.local`. Set the profile,
`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_HYPERDRIVE_ID`, and `CLOUDFLARE_WEB_CACHE_BUCKET`. The cache
bucket must be separate from `MEDIA_BUCKET_NAME`. These identifiers do not provision resources.

Provision Hyperdrive against the existing application database with verified TLS and disabled
query caching: credits, leases and authorization must read current PostgreSQL state. Configure
the origin database credentials in Hyperdrive; they are not copied into Workers secrets. The
generated runtime marker `EZPIC_DATABASE_BINDING=hyperdrive` enables binding-aware readiness
validation. Both wrappers require the actual binding before invoking business code.

The hybrid jobs Container still requires its verified-TLS `DATABASE_URL`. The local origin
credential also remains necessary for separately authorized migrations. Never disable TLS to
make a connection work, and apply migrations before deploying code, not at process startup.

The website binding `IMAGES` and Workers jobs binding `IMAGES` must be enabled in the Cloudflare
account. Images storage is unnecessary; image bytes enter the binding privately and transformed
bytes return to R2. Keep all existing provider, moderation, mail, payment and storage credentials
server-only. Preparation keeps the existing generation and billing gates.

Production identities:

- Website: `ezimageai-site-production` in both profiles, on `https://ezimageai.com`.
- Workers jobs: `ezpic-workflows-workers-production`, Workflow `ezpic-jobs-workers-production`.
- Hybrid jobs: existing `ezpic-workflows-production` and `ezpic-jobs-production`.

Use the selected jobs Worker's `https://<name>.<account-subdomain>.workers.dev/internal/dispatch`
as `WORKFLOWS_DISPATCH_URL`, with the same random secret of at least 32 characters on both sides.
Preparation rejects an endpoint belonging to the other profile. Staging uses separate names
ending in `-staging`, a separate database and buckets, and its own public origin.

```bash
pnpm cloudflare:prepare production
pnpm cloudflare:web:build
pnpm cloudflare:jobs:build
# Additionally for hybrid:
pnpm workflows:build:ci
```

Preparation emits `website.json`, `workflows.json`, their `.secrets.json` files and a public-only
`public-build.env` under `.wrangler/deploy/production/<profile>/`. Build with the intended
allowlisted `NEXT_PUBLIC_` values from that file; they are fixed at build time. A later secret
update cannot change already-rendered public values. The build command strips OpenNext's
embedded `.env` fallback before final bundling so server secrets only come from Worker secrets.
Do not invoke the underlying OpenNext build CLI directly, bypassing that cleanup.

Keep the website's `keep_names: false` Wrangler setting. `next-themes` serializes its
initializer into standalone browser JavaScript; function-name instrumentation inserts a
server-only helper into that script and breaks the initial light/dark theme. The artifact
smoke test executes the rendered initializer and verifies a stored dark-theme preference.

Use Linux/WSL or Linux CI for OpenNext artifact builds. Native Windows Next compilation works,
but OpenNext's copied pnpm junctions can fail during final bundling. The existing standalone
website rollback is preserved via `cloudflare:web:build:legacy` and `cloudflare:prepare:legacy`.

Only after deployment is separately authorized, deploy the generated jobs config and then the
website config with their corresponding `--secrets-file`. The generated configuration already
selects a target; do not add `--env`. No preparation or build command deploys a service.

When using Wrangler directly to deploy OpenNext, populate the build's initial remote R2 cache
with `opennextjs-cloudflare populateCache remote --config <generated-website-config>` before
serving that build. Run it from `apps/saas` with the same build output and prepared target.
This is a remote cache write, not a website deployment. The cache utility also constructs a
local platform proxy; if Hyperdrive local validation requires a connection string, use a
process-local `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` such as
`postgresql://build:build@127.0.0.1:1/build_only`. Cache population does not query PostgreSQL.
Never copy the production origin password into a build environment or persisted local binding.

## Runtime and security boundaries

Each website request owns one database pool. It stays open until its response stream and
registered background work finish, then disconnects. Each jobs invocation owns its pool too.
The shared AsyncLocalStorage context spans OpenNext bundle copies; an unscoped Workers query
fails instead of opening a Node singleton. Local Node development retains the normal client.

`pnpm --filter @repo/database generate` emits separate Node and Workers Prisma clients from the
same schema. The `workerd` condition selects the official edge runtime and its precompiled WASM
query compiler. Keep generated files ignored and regenerate them during builds. This changes
runtime artifacts only; it adds no tables or migrations.

Workers jobs use three named objects in the existing `JOBS_EXECUTOR` namespace:

| Object             | Work                                                                                                      | Admitted concurrency |
| ------------------ | --------------------------------------------------------------------------------------------------------- | -------------------- |
| `jobs-primary`     | Output transfer/finalization, synchronous Gemini/OpenRouter image responses, explicit legacy reinspection | 1                    |
| `jobs-control`     | Ordinary verification, asynchronous provider submission, generation polling/webhooks and settlement       | 4                    |
| `jobs-maintenance` | Outbox delivery, cancellation, guest admission, billing and scheduled recovery                            | 1                    |

The task classification is server-owned in `packages/jobs/src/orchestration/worker-executors.ts`.
Unreviewed provider adapters and new registered task types default to the heavy lane.
Ordinary verification reads bounded media headers; checksum fallback streams the stored object.
New control/maintenance objects reject misrouted tasks before creating database resources.
The original `jobs-primary` still accepts legacy deliveries at concurrency one, preserving heavy
serialization while existing Workflows drain. Do not change the heavy object name to increase capacity.
New names reuse the same class and binding and require no schema migration or additional cron.

Each executor still enforces the existing per-queue cap in addition to its overall cap. Provider
submission routes each have one target; ordinary verification and explicit legacy reinspection
use different lanes, with an aggregate admission ceiling of five matching their queue limit of five.
During cutover, old Workflows may deliver control/maintenance tasks to `jobs-primary`; drain old
Workflows first when strict aggregate provider/queue limits must hold through the transition.
Inline Outbox children execute sequentially within the maintenance parent's occupied slot. A guard
rejects cross-lane inline execution without acknowledging its event; completion-before-ACK remains
required. Do not recursively acquire the same single-slot executor for an inline child.

Objects may share an isolate's 128 MB memory budget, even though each object's active duration is
billed separately. Keep heavy transfers serialized and validate memory and database pressure before
raising any cap. Workflows waits durably when the executor is busy; request cancellation never
prematurely releases execution capacity. The Node executor retains its existing overall and queue caps.
The Durable Object only controls delivery/admission; database leases, immutable ledgers,
uncertain submissions, Outbox acknowledgment and recovery remain in existing business code.

`job.executor` logs include executor name, task/run identity, busy or completed phase, capacity and
elapsed admitted execution time. They exclude payloads, prompts, URLs and credentials. Use busy rate,
execution duration and database/provider limits to tune capacity. Local 5/10/20-request admission
tests establish routing, bounded concurrency and progress under contention; they do not measure
production user capacity, Cloudflare memory headroom, or the account's actual bill.

Normal generation stages immediately deliver their committed Outbox events in a separate durable
step after releasing the executor slot. Pending image verification uses bounded durable polling
at the persisted database retry time. A pending image check makes its Outbox wake-up immediately
deliverable, including when the first check ran inside finalization. The polling Workflow then
waits for the database's five-second image interval; video checks keep their fifteen-second interval.
Delaying the Outbox wake-up itself would make the finalizer's immediate pass miss it and leave
the first poll waiting for the minute recovery schedule. Database leases and due times still fence
overlapping deliveries, and polling reuses the same moderation task without resubmitting it.
Repeated pending image responses reuse one Outbox polling continuation per verification generation,
so increasing the polling frequency does not create a new Workflow for each pending response.
Failed delivery leaves the original Outbox event recoverable;
it never turns a successful provider submission into another submission. The minute schedule is
the recovery path, and maintenance runs sequentially with an Outbox pass before and after recovery.
Approved private outputs can be displayed before finalization and credit settlement finish; asset
ownership, current verification, guest watermark and expiry checks still control signed access.

Both Worker configs require `global_fetch_strictly_public`. The media adapter uses native global
fetch, exact server-owned host allowlists, A/AAAA validation and per-hop manual redirect checks.
The platform blocks private-network destinations at connection time, including DNS rebinding
after preflight. Do not replace global fetch with a VPC or service-binding fetch. Node retains
its pinned HTTPS transport. The two implementations provide platform-appropriate SSRF controls;
the Workers path does not claim application-level IP pinning. Each retains byte caps, deadlines,
bounded multipart buffers and cancellation. See the dedicated local workerd smoke test.

## Images limits and costs

The Images adapter accepts JPEG, PNG and WebP with at most 20,000,000 input bytes, a 12,000-pixel
maximum side and 100 million total pixels. Sharp retains the existing 25 MiB/16,384-pixel bounds.
Oversize, invalid and mismatched images fail explicitly; no unwatermarked original is returned,
and no automatic Container fallback occurs. These are processing limits; existing storage and
admission caps still apply. The branded watermark uses bundled PNG layers with proportional
text so no public font or source-image URL is required.

Images is separately metered from Workers. The published Images Free allowance is 5,000 unique
transformations monthly; Paid includes the first 5,000, then charges $0.50 per 1,000. Free overage
blocks new transformations. Binding `.info()` is free. Check the account's Images plan and
actual binding usage before relying on those quotas; composite operations, retries and other
uses can affect billed transformations. This is not a promise of 5,000 completed generation jobs.
Store transformed output once in R2 to avoid processing again for ordinary image views.

Sources: [Images pricing](https://developers.cloudflare.com/images/pricing/),
[Images bindings](https://developers.cloudflare.com/images/transform-images/bindings/),
[strict public fetch](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public).

## Cutover and rollback

1. Disable new generation and upload admission at the existing feature gates. Let the current
   executor finish active uploads, generations, finalizations and pending Outbox work. Leave
   accepted or uncertain provider submissions reserved until existing recovery settles them.
2. Verify old Workflows, leases, multipart transfers and recoverable events are drained. Stop
   the old scheduled maintenance before enabling the new scheduler. Two schedulers must not
   remain active against the same production database during an ordinary profile switch.
3. Deploy the selected job Worker with its own identity, then the website with the matching
   dispatch URL. Verify the bindings and signed dispatch before reopening generation.
4. Verify login/session cookies, a private upload, an actual image transformation, storage,
   generation callback/polling, failure recovery and credits. Then restore feature gates.

Sharp and Images encode differently. Retrying an unfinished watermarked output across adapters
can produce a different checksum; existing conditional writes intentionally reject that mismatch.
Do not solve it by overwriting stored assets or switching executors after a timeout. Rollback
follows the same drain procedure. Keep the old Container Worker/classes and deployment versions
until the new path is verified; this change does not delete deployed resources automatically.

Local unit/DB/workerd tests and dry builds are separate from live Cloudflare certification.
Hyperdrive origin TLS/cache configuration, Images entitlement/real transformation, private R2,
provider/payment/mail integration and deployed behavior remain `NOT_COMPLETED` until verified
against an authorized staging/production deployment.

## Local artifact verification

After `pnpm cloudflare:jobs:build`, run
`pnpm --filter @repo/workflows test:artifact:workerd`. This loads the final bundled JavaScript
and WASM in workerd, and checks signed request validation at the actual executor boundary.
Add `--database` with the disposable integration `TEST_DATABASE_URL` on loopback port 55432
to execute a real Prisma query through the local Hyperdrive binding. It polls a random missing
attempt without contacting a provider or changing a generation. CI runs both variants.

For the website, run the following in Linux/WSL after the OpenNext build:

```bash
pnpm --filter saas exec wrangler deploy --dry-run --outdir dist/worker
pnpm --filter saas test:artifact:workerd
# With the disposable PostgreSQL database available:
pnpm --filter saas test:artifact:workerd --database
```

The website smoke loads final JS/WASM and static assets, checks login and cache headers, and
optionally performs three concurrent catalog queries without a `DATABASE_URL` secret. Its
database mode verifies the request context across the outer Worker and Next server bundle.
The hybrid Docker image includes Fontconfig/DejaVu for Sharp SVG text. CI also executes
`apps/jobs-runtime/test-support/image-runtime-smoke.mjs` inside the image without network access
and checks for visible lettering, because a successful image encode can still omit text when
the container has no fonts.

The local browser regression uses real disposable PostgreSQL and MinIO with mock generation
providers. The MinIO CORS origin must exactly match `NEXT_PUBLIC_SAAS_URL`, including its port;
use a separate test MinIO instance when an existing local service permits a different origin.
Do not widen a shared service's configuration merely to run this test.
