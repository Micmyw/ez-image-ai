# Cloudflare Workflows and on-demand Node execution

User-approved architecture: replace Trigger.dev orchestration with Cloudflare Workflows and reuse the Node.js media processing chain in Cloudflare Containers. Make routine implementation decisions autonomously. Local implementation and verification only; publishing and deployment are separate.

## Contracts

- PostgreSQL remains the business authority for jobs, attempts, Outbox, reservations, payments and private assets. No schema migration is needed.
- Workflows carry validated internal identifiers and small control results. Provider payloads and media bytes stay in the Node runtime.
- Provider acceptance uncertainty remains reserved and recoverable; orchestration retries cannot bypass attempt claims or route pins.
- Outbox cancellation, admission and storage cleanup acknowledgements follow inline completion. Other deliveries remain pending in PostgreSQL until a Workflow completion receipt; pending checks retain the same logical delivery attempt, and terminal failures follow the existing retry/dead-letter policy.
- The runtime is private behind its Container binding. Node callers use a bounded authenticated dispatch bridge. Production secrets are never bundled in images or browser code.
- One Container instance initially, bounded task concurrency and idle sleep. Durable polling waits release execution capacity. Existing scheduled recovery remains active and failure isolated.

## Functional work

1. Extract a platform-neutral task registry and Node executor, preserving all task handlers, maintenance schedules, polling policy and idempotent continuations. Cover validation, queue metadata, polling ticks and acknowledgement ordering with RED → GREEN tests.
2. Implement Workflows, the private Container bridge and a Node runtime image. Verify authenticated dispatch, duplicate delivery, step retry context, durable polling and concurrency with targeted tests and builds.
3. Switch API dispatch, readiness, environment contracts and CI to Workflows. Update current operations documentation and remove active Trigger configuration and dependencies.
4. Run affected tests, integration checks, workspace gates and local runtime/build checks; perform an independent infrastructure review. Report external verification separately from local evidence.

## Ownership and existing work

Work occurs on local branch `codex/cloudflare-workflows` from `544d17f747e19a7e5a1f590d87dea24950cd00a6`. No worktree was created. Existing dirty moderation, provider polling, quote and landing changes must be preserved. The Node executor and API/config cutover are delegated as two coherent independent units; the main agent owns the Worker, runtime server, dependencies, integration and final verification.

## Verification boundaries

Use focused RED → GREEN tests first, then cross-workspace checks because execution recovery and billing processing are affected. Local mocks, Docker builds and Wrangler dry runs do not certify Cloudflare deployment, production secrets, real payment providers or image providers. Record unavailable external checks as `NOT_COMPLETED`.

## Verification follow-up

The implementation and independent infrastructure review are complete. Completion receipts,
polling deadline handling and process exit recovery were verified before the final artifact build.
The full PostgreSQL integration runner passed 938 tests; workspace types and unit/contract gates
passed. See the [local verification record](../../operations/evidence/cloudflare-workflows-local-verification-2026-09-08.md).

Production-build browser verification exposed a native draft handoff that used an internal
request origin. Six regression cases reproduced the redirect mismatch before the correction;
the API and continuation route now use the existing configured/validated SaaS origin. Focused
checks passed 52 tests and independent review found no blocking issue. The complete browser
suite then passed against the final source: 18 media/auth/SEO tests and 15 public/guest tests.
