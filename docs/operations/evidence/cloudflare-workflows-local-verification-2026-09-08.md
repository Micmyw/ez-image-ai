# Cloudflare Workflows local verification

Candidate: local branch `codex/cloudflare-workflows`, based on
`544d17f747e19a7e5a1f590d87dea24950cd00a6`, with uncommitted changes. This is a local
verification record, not a deployment certificate. Existing moderation, image-approval,
provider-polling, quote and landing work was preserved in the working tree.

## Implemented boundary

`apps/workflows` replaces Trigger dispatch, durable waits, retries and maintenance.
`apps/jobs-runtime` preserves the Node/Prisma/Sharp processing chain in a private Container.
PostgreSQL owns business state and completion-fenced Outbox recovery. The SaaS Next.js
hosting adapter and cloud deployment are separate from this background execution change.

The initial configuration permits one basic Container and four active Node invocations,
with task-specific limits still enforced. Idle shutdown is ten seconds after work finishes;
scheduled maintenance also starts the Container. Infrastructure cost has not been measured.

## Completed checks

- Behavioral RED to GREEN tests cover dispatch validation, executor routing, polling,
  authenticated admission, capacity, and completion receipts. Pending Outbox delivery keeps
  its logical attempt; expired or duplicate lease operations cannot decrement it again.
- Full unit/contract runner passed across config, AI, storage, payments, database, jobs,
  Workflows, Node runtime, API, SaaS and E2E contracts. The added Outbox database helper tests
  passed separately and were included in the runner afterward.
- Full workspace type checking passed: 21 tasks.
- Full PostgreSQL integration runner passed: database 176 + 82, jobs 94, API 574 + 12;
  938 tests total, with isolated task-owned test databases.
- The Workflows suite passed 14 tests, including two tests using local workerd Workflow
  steps. Container calls are mocked in those workerd tests.
- Repository lint with denied warnings, formatting and diff whitespace checks passed.
- CI infrastructure contract and launch-evidence template validation passed. Launch evidence
  intentionally remains `NOT_COMPLETED` for unprovisioned external resources.
- Worker and Linux Container artifact build passed with frozen-lockfile and release-age
  validation. BuildKit dependency caching and a longer download timeout resolved npm network
  timeouts without changing registries or dependency policy.
  Final local image: `ezpic-workflows-jobscontainer:worker`,
  `sha256:6ae01cd184fa19d85b0e4ccadb38231f4442370d8d7b43d79da191ebe68bf38f`.
- The built Linux image started as UID 1000. Health returned zero active jobs; unsigned
  execution returned 401; signed execution used the canonical settlement handler for a
  nonexistent test job and returned only `{ "status": "ok" }`. Native Sharp encoded and
  inspected an image. SIGTERM exited cleanly with code zero and no remaining container PID.
- The production-build browser media/auth/SEO batch passed 18/18 through real local
  PostgreSQL, private MinIO and the local Outbox pump with mock providers. The final
  public/guest batch passed 15/15: 33 browser tests in the complete harness, with exit code zero.
- The continuation correction below reproduced six failures before implementation. Its final
  focused checks passed 52 tests; API and SaaS types passed, and independent review found no
  blocking issue. The original infrastructure review also closed its concrete findings.

## Browser follow-up

Testing on port 3100 used a task-owned MinIO instance with the exact browser origin permitted.
The guarded Chromium local-network option now applies to all media projects. The Next test
server binds the configured browser hostname.

Repeated guest runs need a fresh disposable database because the existing local guest-upload
proof is single-use. Its server replay protection was retained.

Raw response instrumentation confirmed the remaining guest failure: anonymous sign-in
returned a `localhost:3100` continuation to a browser using `127.0.0.1:3100`, so Chromium
enforced the existing same-origin form policy. Anonymous login now uses the already-validated
SaaS origin; success/error draft continuation uses the existing canonical site URL helper.
Origin/bootstrap checks, session cookies and CSP remain enforced. The complete browser rerun
passed on a fresh database after this correction. Temporary diagnostics stayed outside the
repository and were absent from the successful full rerun.

## Cleanup

The final image smoke container, task-owned PostgreSQL and MinIO containers, their temporary
storage and the smoke network were removed. The earlier scratch database in the shared local
PostgreSQL service was dropped after verifying it had no connections. All recorded task process
trees exited. The existing development server on port 3000 and shared PostgreSQL/MinIO services
remained running. The local build image remains available for review.

## External verification

Cloudflare deployment, protected secrets, a live authenticated Container-to-Workflow callback,
platform cold starts and idle shutdown, real Provider/moderation/payment/storage connectivity,
load budgets, billed cost and rollback remain `NOT_COMPLETED`. Local mocks, Linux smoke tests
and Wrangler dry builds do not satisfy these checks. No push, merge or deployment was performed.
