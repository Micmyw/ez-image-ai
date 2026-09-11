# Cloudflare Workflows and Node job containers

New low-cost deployments default to a Workers executor with Cloudflare Images. See
[Workers deployment profiles](cloudflare-workers-profiles.md) for preparation, Hyperdrive,
runtime limitations and drain/cutover. This runbook's Node Container executor is the `hybrid`
profile; its leases, Outbox, recovery and signed dispatch remain the same in both profiles.

## Execution boundary

SaaS commits the GenerationJob, input bindings, credit reservation and initial Outbox row before
calling the private Workflows dispatch endpoint. `apps/workflows` authenticates dispatch requests,
starts durable execution, waits between polls and retries, and schedules maintenance.
`apps/jobs-runtime` runs the existing `@repo/jobs` handlers in a Cloudflare Container with Node,
Prisma, Sharp, file-type, streams and the existing Provider, payment, moderation and storage clients.
The website uses a separate Worker and Next.js Node Container described in the
[website hosting runbook](./cloudflare-hosting-runbook.md). Both deployments require their own
runtime secrets and live verification.

PostgreSQL remains the only business source of truth. Workflow instance IDs and steps are delivery
metadata. Duplicate Workflow admission must still pass the same PostgreSQL claim, lease token and
conditional transition. Provider acceptance uncertainty still prohibits resubmission, cancellation,
failover or release of reserved credits until recovery resolves the same attempt.

Outbox delivery is confirmed only after execution completes. Cleanup, cancellation and guest
admission execute inline; other events retain their PostgreSQL obligation until the Worker reports
a completed Workflow. While execution is pending, lease-fenced deferral preserves the delivery
attempt and its Workflow ID. A terminal failure follows the existing backoff and twelve-attempt
dead-letter policy. Monitor pending age and dead letters, including failures before Node admission.
The Node runtime terminates on an exceeded task deadline so a hung operation cannot keep a paid
container alive indefinitely; interrupted work is recovered from PostgreSQL leases and Outbox.

The initial container configuration uses one `basic` instance. Durable polling sleeps occur in
Workflows, not in a resident Node polling loop. The container can stop after 10 seconds of idle time
once active work has completed; the next execution starts it again. Scheduled maintenance also
wakes it, including during periods without new user jobs. This is not a promise of zero background
compute cost. Cloudflare Containers, Workflows, database, storage and outbound traffic have their
own usage charges beyond a Workers base subscription. Measure cold-start latency, active runtime,
memory, disk and transfer usage in staging before setting a production budget or raising capacity.

## Isolated configuration

Use distinct Worker names, Workflow bindings/names, Container/Durable Object resources, database,
private bucket and secret scopes for development, test, staging and production. The checked-in
Wrangler configuration has separate `staging` and `production` namespaces; this is configuration,
not evidence that those resources are provisioned. Review the exact names and bindings before
deployment; do not point two environments at the same resources. Keep development and test targets
isolated as well. Record the non-secret identities in the environment matrix under
`workflowEnvironment`, using `EZPIC_WORKFLOWS_ENVIRONMENT_ID` for the application launch check.

Configure these server-only values:

| Location                   | Required configuration                                                                                                                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SaaS                       | `WORKFLOWS_DISPATCH_URL` as the full HTTPS `/internal/dispatch` URL; `WORKFLOWS_DISPATCH_SECRET`; `EZPIC_WORKFLOWS_ENVIRONMENT_ID`                                                                                            |
| Worker secrets             | The same `WORKFLOWS_DISPATCH_SECRET`, `WORKFLOWS_DISPATCH_URL`, and `JOBS_RUNTIME_ENV`                                                                                                                                        |
| Node Container environment | Injected from `JOBS_RUNTIME_ENV` at startup: string-valued `DATABASE_URL`, existing media/Provider/storage/moderation/payment configuration and applicable launch/runtime controls; the Worker enforces `NODE_ENV=production` |

Generate a random dispatch secret of at least 32 characters. The dispatch client signs each request
with HMAC; request and response contents are private and must not appear in browser configuration
or readiness diagnostics. In production, the endpoint must use HTTPS without userinfo, query or
fragment. A non-production Node caller may use `http://127.0.0.1:8787/internal/dispatch` for an
explicitly started local Worker. The Container always runs in production mode, including during
local previews, so its callback URL needs a reachable non-loopback HTTPS endpoint. An HTTP-only
Wrangler preview does not exercise the complete Container-to-Workflow callback path.

`JOBS_RUNTIME_ENV` is a JSON object whose values are strings. Store it as a Cloudflare Worker secret,
never in Wrangler `vars`, source control, a Docker build argument, a container image layer, logs or
public configuration. Retain Provider recovery credentials for frozen historical attempts until
they drain. Provision the same moderation policy and credential versions in SaaS and Node. The
initial Node admission limit is four active invocations (`JOBS_RUNTIME_CONCURRENCY` inside
`JOBS_RUNTIME_ENV`), with the existing task-specific database guards still applied.
`TRIGGER_PROJECT_REF`, `TRIGGER_SECRET_KEY` and Trigger access tokens are no longer runtime or CI
prerequisites for this revision. Preserve old credentials only in the prior deployment's protected
rollback scope until the cutover is accepted.

## Build and deployment preflight

Install Node 22+, the repository's pinned pnpm, and Docker. Docker must be running when building or
locally executing the container image. The Docker build uses the repository root as context; its
ignore rules must exclude local env files, credentials and generated development outputs.
The Docker dependency layer uses a BuildKit pnpm store cache, eight concurrent downloads and a
five-minute request timeout for large native dependencies. Frozen-lockfile and release-age checks
remain enabled.

From the exact candidate revision:

```bash
pnpm install --frozen-lockfile
pnpm --filter @repo/database generate
pnpm workflows:type-check
pnpm workflows:build:ci
pnpm verify:ci-workflow
pnpm launch:evidence:validate
```

CI always runs the type and artifact build gates without Cloudflare account or Trigger credentials.
A successful dry build proves only the artifacts. It does not certify Container startup/shutdown,
HMAC ingress, scheduled delivery, durable sleep/retry, a live Provider, storage or payments.

Deploy only after target-specific secret configuration, migrations and release authorization. Use
the selected target's Wrangler configuration when setting secrets and deploying its Worker and
matching container image. From `apps/workflows`, use `pnpm exec wrangler deploy --env staging`, then
`--env production` only for the separately approved promotion. Supply the same explicit `--env`
for every secret operation; for example, `pnpm exec wrangler secret put JOBS_RUNTIME_ENV --env staging`
reads the runtime JSON into that target's protected secret. Never run business migrations when the
Container starts.

## Cutover and drain

1. Record the exact current web/worker revisions, new Worker revision and container image digest,
   migration revision, environment IDs, pending Outbox rows, active leases, accepted attempts,
   payment backlog and invariant results. Take and verify an isolated database restore.
2. Keep new generation and paid checkout disabled for the transition. Pause the previous Trigger
   schedules, dispatch ingress and worker consumption with its actual deployment controls. Billing
   switches do not pause every webhook or maintenance path. Preserve retryable webhook ingress
   where required, and wait for in-flight workers and leases to drain.
3. Deploy the matching Cloudflare Worker/Workflow and Node image in isolated staging. Configure the
   SaaS dispatch URL/secret and resource identity. Verify the private dispatch endpoint rejects
   missing, malformed, expired and invalid signatures and the Container executor is not public.
4. Verify every task in the Node executor manifest, scheduled maintenance, durable polling waits,
   bounded retry, guest admission and private media processing. Immediate API dispatch uses
   `generation:<jobId>:<version>`; Outbox redelivery uses its own claim identity so exhausted
   Workflow instances cannot permanently suppress recovery. Existing PostgreSQL claims exclude
   duplicate domain execution.
5. Exercise duplicate dispatch, a lost dispatch response, a stopped Container, polling timeout,
   uncertain Provider acceptance, private transfer failure, moderation rejection, payment replay,
   cleanup, dead-letter handling and recovery of previously persisted rows. Reconcile credits and
   verify there was no duplicate Provider submission, grant, settlement or refund.
6. Promote the exact tested Worker and Node image with the corresponding web revision. Confirm
   `/api/ready` names the admin check `workflows`; public responses remain only ready/not_ready.
   Its configuration check does not prove remote Worker availability. Record a real authenticated
   dispatch, completed workflow, idle stop and restart, cron recovery and external-service evidence
   before enabling a small production cohort.

Do not run the old scheduler alongside the new maintenance deployment as an undocumented fallback.
The database guards reduce duplicate business effects but do not make mixed scheduler ownership a
verified release strategy.

## Failure recovery and rollback

If dispatch is unavailable, successful job creation retains its Outbox recovery path. Disable new
generation if backlog or user latency exceeds the documented thresholds. Inspect Worker request
errors, Workflow retries, Container cold starts/exits, database locks/leases, Outbox lag/dead
letters and Provider status. Replay only persisted work through the existing recovery path; never
resubmit an uncertain Provider task to obtain a new external task ID.

Roll back Worker and Node image together with a compatible web revision. Record the exact versions
and Container digest. If reverting across the Trigger cutover, pause and drain Cloudflare ingress,
Workflow execution and maintenance first, restore the prior web/Trigger revision and protected
configuration, then resume its schedules only after confirming durable payload/schema compatibility
and credit/payment/storage invariants. Keep new work disabled until the recovery drill and
`/api/ready` pass for that revision. Do not revert additive database history or rewrite ledger,
attempt, reservation or Outbox records to make old code fit.

## Required live evidence

Deployment, authenticated ingress, all registered tasks, durable sleep/retry, Container shutdown
and restart, maintenance/replay, cold-start and load budgets, Provider/moderation/storage/payment
connectivity, billed infrastructure cost, alert delivery and rollback are `NOT_COMPLETED` until
recorded against the exact target revision. See the [launch checklist](./ezpic-launch-checklist.md)
and [production rollback guide](./ezpic-rollback.md). Local mocks and artifact builds cannot turn
those rows into `PASS`.
