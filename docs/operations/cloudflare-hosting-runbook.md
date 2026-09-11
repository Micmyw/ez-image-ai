# Cloudflare website hosting

For new deployments use [Workers deployment profiles](cloudflare-workers-profiles.md).
`cloudflare:prepare` and `cloudflare:web:build` now target the Workers website. The commands and
Container topology below are retained for legacy rollback; use `cloudflare:prepare:legacy` and
`cloudflare:web:build:legacy` when following this legacy procedure.

The public site, guest workspace, authenticated app and Docs share `https://ezimageai.com`.
`apps/web-host` forwards that origin to a private Next.js standalone Node Container. The website
Container is separate from the Workflows/jobs Container. Prisma, Sharp and the current Node
database pools keep their existing execution model; no OpenNext adapter is involved.

## Resource identities

| Resource              | Production configuration                                                          |
| --------------------- | --------------------------------------------------------------------------------- |
| Cloudflare account    | `44c8c5cb3ce2004d398ff271836bdd2e`                                                |
| Website Worker        | `ezimageai-web-production`                                                        |
| Website domain        | `ezimageai.com`                                                                   |
| Background Worker     | `ezpic-workflows-production`                                                      |
| Dispatch endpoint     | `https://ezpic-workflows-production.15871497752myw.workers.dev/internal/dispatch` |
| Supabase organization | `Micmyw's Org` (`oirjdxuzhjzginsifvrh`)                                           |
| Supabase project      | `ezimageai-production` (`cresrmesgalqdgbxtyvm`), Singapore                        |
| Private media bucket  | `ezimageai-media-production`                                                      |
| Private avatar bucket | `ezimageai-avatars-production`                                                    |

These identities describe the deployment target, not a live-service certification. Keep staging
database, buckets, secrets and Worker identities separate before deploying staging. The checked-in
staging Worker namespace does not provision a staging database or bucket.

## Local configuration and build

Keep real values in the ignored `.env.production.local`. `DATABASE_URL` uses the dedicated
`ezpic_app` role; Supabase supplies PostgreSQL only. Better Auth and R2 remain the auth/storage
implementations. Do not add Supabase browser keys or a service-role key to the website.

The official public CA lives in `tooling/certificates/supabase-prod-ca-2021.crt`, downloaded from
[Supabase's certificate distribution](https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt).
Its SHA-256 fingerprint is `807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA`;
it expires on April 26, 2031. Use `sslmode=verify-full` and an absolute local `sslrootcert` path.
Both images contain this certificate at `/app/tooling/certificates/supabase-prod-ca-2021.crt`;
preparation changes the certificate path for the containers without changing the credentials.
See [Supabase connection guidance](https://supabase.com/docs/guides/database/connecting-to-postgres).

```bash
pnpm cloudflare:prepare production
pnpm --filter @repo/web-host type-check
pnpm --filter @repo/web-host test
pnpm --filter @repo/web-host exec wrangler deploy --dry-run --config ../../.wrangler/deploy/production/web-host.json
pnpm --filter @repo/workflows exec wrangler deploy --dry-run --config ../../.wrangler/deploy/production/workflows.json
```

Preparation emits configs and secret JSON files beneath `.wrangler/deploy/production`, which is
ignored by Git and Docker. It removes test/load credentials and only passes explicitly allowed
`NEXT_PUBLIC_` values as public image build arguments. Regenerate after editing the env file.
All other credentials enter through Worker secrets at container startup. Do not pass a real DB,
auth, mail, provider or storage secret as a Docker build argument. The dummy build-stage values
only satisfy import-time configuration and are absent from the final image environment.

Preparation reports missing integrations; it is not the full launch validator. Keep generation,
guest generation and billing disabled until their existing readiness/certification contracts pass.
Configure and verify mail sender ownership before opening registration. Verify OAuth callbacks
with the canonical origin if Google/GitHub login is enabled.

For basic website error monitoring, set `SENTRY_DSN`, `ERROR_MONITORING_ENABLED=true`, the native
SDK's `SENTRY_ENVIRONMENT` and the matching `EZPIC_SENTRY_ENVIRONMENT` resource identifier. Set
`DEPLOYMENT_VERSION` to a real deployed revision or image-linked release. Use
`SENTRY_TRACES_SAMPLE_RATE=0` to disable performance tracing while retaining errors. The existing
server/edge initialization applies the shared redaction hook and disables default PII collection;
it does not add browser Replay or instrument the private jobs executor. Deploy runtime changes and
reload the website Container as described below. An accepted local SDK test proves ingestion,
while a deployed exception, dashboard visibility and alert delivery need their own evidence.

## Database migrations and browser isolation

Apply the canonical Prisma migrations before deployment. With Node 22, from `packages/database`:

```bash
node --env-file=../../.env.production.local node_modules/prisma/build/index.js migrate deploy
node --env-file=../../.env.production.local node_modules/prisma/build/index.js migrate status
```

After migrations, run `docs/operations/supabase-private-postgres.sql` through the Supabase project
administrator to apply RLS/default privilege restrictions and fixed trigger-function search paths.
Repeat after new migrations create tables or replace functions. The app role owns its tables and
connects directly; `anon` and `authenticated` must have no schema or table access. Do not create
public RLS policies just to silence the intentional backend-only
[`rls_enabled_no_policy` information](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy).
Prisma remains the domain migration authority. Never run migrations on Container startup.

The Free project has quota, availability and backup limitations; no Supabase paid plan was enabled
by this setup. Review the project plan and backups before accepting production availability targets.

## R2

Both buckets use `docs/operations/cloudflare-r2-cors.production.json`: exact HTTPS origin, GET/HEAD/PUT,
required checksum headers and exposed ETag. Keep managed public URLs disabled and do not attach
public bucket domains. Create S3 Object Read & Write credentials scoped to these two buckets.
Private assets still use server-authorized short-lived URLs. Never expose the S3 credentials in
`NEXT_PUBLIC_` variables. Verify upload/read/delete, browser preflight and anonymous denial.

## Authorized deployment

From the repository root, after reviewing the generated target configuration and supplying all
enabled-service credentials:

```bash
pnpm --filter @repo/workflows exec wrangler deploy --config ../../.wrangler/deploy/production/workflows.json --secrets-file ../../.wrangler/deploy/production/workflows.secrets.json
pnpm --filter @repo/web-host exec wrangler deploy --config ../../.wrangler/deploy/production/web-host.json --secrets-file ../../.wrangler/deploy/production/web-host.secrets.json
```

Wrangler uploads secrets with the Worker version. The jobs Worker requires three secrets:
`WORKFLOWS_DISPATCH_URL`, `WORKFLOWS_DISPATCH_SECRET`, and `JOBS_RUNTIME_ENV`. The website Worker
requires `WEB_RUNTIME_ENV`; its canonical origin is a public Worker variable. The generated config
already selects an environment; do not add `--env` to these commands. Avoid printing or committing
the secrets files. Record Worker versions and image digests from actual deployment results.

For runtime-only secret updates, rerun preparation and deploy both Workers. The deployment commands
can use `--containers-rollout=none` to preserve the existing images and skip image builds. An unchanged image
can make Wrangler report no Container changes; that does not prove a running Node process has
loaded the new secrets. Confirm an idle stop and subsequent start, or use the authenticated
Containers application rollout API to reapply that application's current configuration with a
rolling rollout. Scope the rollout to the intended application, preserve its image and limits,
and wait for completion and a healthy instance before checking the website. Keep runtime values
in Worker secrets; never add a public restart endpoint or print the container environment.

Verify `/api/health`, `/`, `/docs`, `/login`, static assets, auth origin/cookies and `/api/ready` on
the actual domain. Run a signed workflow and verify its database result, idle shutdown, cold restart
and scheduled recovery as described in the [Workflows runbook](./cloudflare-workflows-runbook.md).
Check storage, moderation, generation and refunds using the existing controlled live-service paths.
Keep the [launch checklist](./ezpic-launch-checklist.md) incomplete until its evidence exists.

## Capacity, cost and rollback

Website settings start at one `basic` instance, with a five-minute idle stop. Jobs also start at one
`basic` instance, with a ten-second idle stop after work completes. Incoming traffic and minute
maintenance can keep or wake containers; Workers Paid does not cover all usage. Measure cold starts,
runtime, connection counts, error rates and actual billing before promising capacity or increasing
limits. A single website Container is not a high-availability or high-concurrency certification.

Rollback the website Worker and matching image together. Preserve a compatible database schema;
never reset the production database or rewrite the credit ledger. Background rollback additionally
needs scheduler drain and Outbox recovery checks from the Workflows runbook. Missing integration
credentials, incomplete mail/domain verification and live evidence remain `NOT_COMPLETED` even when
local image builds and read-only database checks pass.
