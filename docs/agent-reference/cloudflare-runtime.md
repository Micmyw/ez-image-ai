# EzPic Cloudflare runtime constraints

Read for job/runtime/database packaging or deployment changes. Operational cutover, drain, rollback, bindings, and live checks remain in `docs/operations/cloudflare-workers-profiles.md` (repository-root path).

## Jobs

- API work uses `dispatchJob` from `@repo/jobs/orchestration/client`. `WORKFLOWS_DISPATCH_URL` includes `/internal/dispatch` and requires HTTPS in production. SaaS and Worker share a random `WORKFLOWS_DISPATCH_SECRET` of at least 32 characters.
- `apps/workflows` owns durable dispatch/retry/sleep and scheduled maintenance. Default `workers` admits existing handlers through the private `WorkerJobs` Durable Object, with request-owned Hyperdrive/Prisma connections and Cloudflare Images. `hybrid` uses `apps/jobs-runtime` with Sharp.
- WorkerJobs uses three named objects in the existing namespace: `jobs-primary` for heavy work (1), `jobs-control` for lightweight work (4), and `jobs-maintenance` for maintenance (1). Routing and inline-child boundaries live in `packages/jobs/src/orchestration/worker-executors.ts`. Keep large-image responses serialized; object names do not provide independent 128 MB memory allocations.
- Workers use flat secrets and injected contexts. Origin credentials stay in Hyperdrive with verified TLS and query caching disabled. Hybrid containers receive `JOBS_RUNTIME_ENV` JSON secrets at startup; never embed credentials in artifacts/public variables.
- `pnpm workflows:type-check` checks orchestration/Node boundaries; `pnpm cloudflare:jobs:build` builds Workers artifacts; `pnpm workflows:build:ci` builds hybrid artifacts without Cloudflare credentials. Container build/execution needs Docker.

## Website and database runtime

- Both deployment profiles use `apps/saas/cloudflare-worker.ts` and OpenNext. Request contexts outlive response streams and registered background work, then disconnect Prisma. `workerd` adapter conditions exclude native Sharp/Node HTTPS.
- Both Worker configs require `global_fetch_strictly_public`; media URLs must never use VPC fetch.
- Workers fetch supports `redirect: "manual"`, not `redirect: "error"`. Signed Waffo merchant
  status and prompt-verification requests use manual mode and reject non-2xx responses without
  following their `Location` headers. Verify these boundaries in workerd as well as Node tests.
- Generate separate Node and `runtime = "workerd"` Prisma clients. Database runtime imports use `#prisma-runtime-client`; other packages use `@repo/database/generated-client`. Direct generated-path imports are type-only. Do not bundle Node Prisma into Workers or edit generated clients.
- Verify final job artifacts with `pnpm --filter @repo/workflows test:artifact:workerd`; `--database` needs a disposable loopback `TEST_DATABASE_URL` on port 55432. Source tests and Wrangler dry builds alone do not establish final WASM loading.
- `pnpm cloudflare:prepare production` creates ignored deployment configs and secret files from `.env.production.local`. Only allowlisted `NEXT_PUBLIC_` values become build args; test/load credentials are stripped. Preparation is not deployment or enabled-integration certification.
- `EZPIC_DEPLOYMENT_PROFILE` defaults to `workers`; `hybrid` changes jobs only. Use `pnpm cloudflare:web:build` for OpenNext and env-fallback removal; do not bypass its wrapper. Final packaging uses Linux/WSL because native Windows pnpm junctions can fail.
- Preserve rollback assets in `apps/web-host`, `apps/saas/Dockerfile`, and `cloudflare:*:legacy` commands.
- Supabase provides PostgreSQL only; Better Auth and private R2 remain. Apply Prisma migrations before `docs/operations/supabase-private-postgres.sql` as project administrator to restrict browser roles. Never weaken TLS; containers carry the official public root CA.

None of these local builds proves live deployment, cron/recovery behavior, Container shutdown, provider acceptance, or external integrations. Preserve leases/ledger/Outbox and existing uncertainty handling throughout runtime changes.
