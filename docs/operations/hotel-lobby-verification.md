# Hotel Lobby duo verification and rollout

This receipt separates local implementation from real provider acceptance and public availability.
For the later owner-authorized authenticated public beta, see the
[follow-up rollout](hotel-lobby-public-rollout.md). The internal-only and missing
production-authorization statuses below describe the original implementation batch.
Baseline: `96f47c92d5d32bd20640e7029ab08f88a916c4f1`.
Updated main incorporated before final publication:
`1d9f3136e5230dbc9dab17803d002479d7eb463d`.
During final packaging the shared remote-tracking ref advanced to
`55144d959af1b0228490174447094d22376f7530`. Its three compatibility/test changes were
read and add no migration or different paid-request policy. The local build receipt
below belongs to this feature tree based on `1d9f3136`, not to that later main tree;
pull-request CI validates the current merge context separately.
Worktree/ownership: [implementation map](../implementation/hotel-lobby-file-map.md).
The user's later instructions authorize pushing the completed feature branch and,
after passing checks, merging and pushing main. The pricing follow-up explicitly
requires revenue at least three times complete cost. Main was integrated again at
`14d26d2a72c3eb656dd689f9a99e1011e81c3e3a`, preserving its latest ordinary-video
acceptance records and repairs. Paid calls and public activation remain separate
gates. Git, automatic deployment and database migration evidence must be reported
independently of the local checks below.

## External gates

| Item                                      | Status     | Required evidence                                                                                                                                               |
| ----------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Template-specific paid test authorization | BLOCKED    | Explicit budget, owner and candidate tuples; old administrator funding is not reused                                                                            |
| Composite cost policy                     | LOCAL PASS | Version .2 computes 69 credits at the documented conservative budget and enforces revenue >= 3x complete cost; merchant actual-cost acceptance remains separate |
| Provider account permissions              | PARTIAL    | Existing credential authenticated by read-only balance GET; exact model entitlement and paid template call NOT_RUN                                              |
| Two-person quality comparison             | NOT_RUN    | Same authorized input groups for candidate A/B, all results and receipts retained                                                                               |
| Real private R2/video/SeeAPI delivery     | NOT_RUN    | Same immutable stored MP4, authentic callbacks and one actual wallet settlement                                                                                 |
| Twelve-group release quality check        | NOT_RUN    | At least ten acceptable groups and no severe identity/audio failures; do not market this as a statistical success rate                                          |
| Three public product examples             | BLOCKED    | Rights-cleared independent public copies, real job evidence and exact matching template version                                                                 |
| Production migration/deployment/opening   | NOT_RUN    | Separate authorization plus the above gates                                                                                                                     |
| GSC/ChatGPT search appearance             | NOT_RUN    | Actual search/provider observations; no discovery guarantee                                                                                                     |

The official candidate references are
[Nano Banana 2 Lite](https://docs.kie.ai/market/google/nano-banana-2-lite),
[Seedance 1.5 Pro](https://docs.kie.ai/market/bytedance/seedance-1-5-pro),
and the existing repository model/pricing contracts. The PRD's scene USD0.02 and video
USD0.0875/USD0.08 numbers are research references, not this task's merchant receipts,
complete cost, or approved retail price. No real sample was manufactured or copied from Migos.

The later owner-authorized price decision, refreshed public sources, complete
69-credit budget and model-permission preparation are recorded in
[the pricing receipt](hotel-lobby-pricing-2026-10-05.md). That receipt supersedes the
earlier missing-price status; it does not convert public prices into account invoices
or ordinary-video samples into template acceptance.

## Private configuration

New admission requires `HOTEL_LOBBY_DUO_ENABLED=true` independently of the existing
video admission switch. Both Workers must receive the same private policy. The strict
video option allowlist must also explicitly permit the selected image-to-video,
5-second, 720p, silent combination.

The frozen template version, separate approved price version/basis/expiry and safety
cost version are required. Scene supplier cost, each input image check, scene image
check, both text checks, additional runtime/storage budgets are explicit. Zero text
cost requires a separately stated basis and matching text policy; omitted cost never
means zero. Existing payment allocation and nonbillable-failure factors are applied
once to the complete combined budget. An expiring template-specific internal funding
authorization is separate from ordinary video administrator acceptance.

The immutable snapshot freezes ordered role identities, prompts/versions, preprocessing,
safety policy, fixed output, scene capacity and retention. Two references may use the
same asset; their role mapping remains explicit. Scene canonical bytes are limited to
10,000,000, with a conservative separate 20,000,000-byte scene capacity reservation.
Final video capacity remains 100 MiB; this does not override SeeAPI's separate
100,000,000-byte review ceiling.

## Local environment and commands

Task-owned PostgreSQL 16 container: `ezpic-hotel-lobby-test-20261005`,
bound only to `127.0.0.1:55439`, database `ezpic_video_v1_final_test`.
It contains disposable fixtures, not production data. Real provider traffic is blocked
by `tests/video-v1/no-paid-network.mjs` for the concentrated runner.

Initial local setup:

- `pnpm install --frozen-lockfile`
- `pnpm --filter @repo/database generate`
- `pnpm --filter @repo/database exec prisma migrate deploy` against the isolated URL
- `pnpm --filter @repo/database exec prisma migrate status`

Migration `20261005100000_video_template_scene` was generated from the actual baseline
database using Prisma migrate diff, then extended with PostgreSQL content-identity,
paid-attempt and output-binding guards. Historical migrations are unchanged.
Prisma generates both Node and workerd clients and tracked Zod types.

Concentrated unit/Mock command:
`pnpm exec tsx tests/video-v1/run.ts --hotel-lobby`.
Concentrated database command:
`pnpm exec tsx tests/video-v1/run.ts --integration --hotel-lobby`,
with the explicit safe loopback `TEST_DATABASE_URL`.
SaaS Vitest, Next/Fumadocs and browser runs must execute sequentially.

The requirement-by-requirement recovery matrix, exact test names and limitations are
in [T01–T26](../implementation/hotel-lobby-test-map.md). Test transport fixtures are
never public product examples. The private MinIO check uses only the task-owned
`ezpic-hotel-lobby-minio-20261005` container on loopback port 64266.

## Verification receipt

Tasks 0–5 have implementation and local evidence. Task 6's real candidate comparison,
sample generation and limited release are blocked by the external gates above.

| Layer / command                                                                                                                              | Result and scope                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fresh migrations and Prisma drift                                                                                                            | PASS: all 62 migrations applied in timestamp order to empty `ezpic_hotel_fresh_test`; `migrate status` current; `migrate diff --from-schema prisma/schema.prisma --to-config-datasource --exit-code` reports no difference           |
| Concentrated unit/Mock, `pnpm exec tsx tests/video-v1/run.ts --hotel-lobby`                                                                  | PASS after incorporating updated main: 1,238 tests, 73 files; all external paid traffic blocked                                                                                                                                      |
| Concentrated PostgreSQL                                                                                                                      | PASS after merge: 251 database + 29 jobs tests = 280 passed, 3 optional performance tests skipped, 14 files; 87.069 seconds wall clock (56.58 seconds database + 26.15 seconds jobs test runners)                                    |
| Isolated MinIO, `pnpm --filter @repo/storage test:minio:video`                                                                               | PASS: 5 cases using real local object I/O; JPEG, PNG and WebP rotate/strip EXIF into the same canonical bytes used for review and submission                                                                                         |
| Template browser, `pnpm --filter saas exec playwright test --config modules/video-v1/playwright.config.ts hotel-lobby-public-routes.spec.ts` | PASS: 7 Mock scenarios, 1.0 minute; screenshots inspected at 1440/390/320px; no horizontal overflow, actual labels and keyboard access                                                                                               |
| Ordinary video browser                                                                                                                       | NOT_RUN in this batch: no additional local authenticated seed was created. Ordinary native Workflow, SQL, unit and backend artifact checks run separately                                                                            |
| SaaS types, `pnpm --filter saas type-check`                                                                                                  | PASS: Next route types, Fumadocs and TypeScript. Final website build checks the merged dependency graph again                                                                                                                        |
| Nine affected backend workspaces                                                                                                             | PASS: config, storage, database, AI, jobs, API, Workflows, web-host and jobs-runtime; 31.226 seconds. API now explicitly uses the ES2022 standard library matching its existing target                                               |
| CI routing, `pnpm verify:ci-workflow` and `pnpm exec tsx --test tests/load/run-integration.test.ts`                                          | PASS; 24 routing tests. Template SQL flow is in the ordinary integration runner/package script; template browser spec is included in the existing guarded video UI configuration                                                     |
| Local ledger invariant query, `pnpm verify:invariants` with explicit disposable URL                                                          | PASS: zero duplicate jobs/settlements, reservation/allocation/lot/account inconsistencies or missing durable handoffs. Queue latency has no sample and does not prove P95                                                            |
| Changed-file Oxlint/Oxfmt and `git diff --check`                                                                                             | PASS for 119 affected source/config files; generated Zod is generated by Prisma, not hand-formatted                                                                                                                                  |
| Final native Workers bundle and database smoke                                                                                               | PASS: `pnpm cloudflare:jobs:build` 5.970 seconds; `pnpm --filter @repo/workflows test:artifact:workerd --database` 2.923 seconds; actual packed Prisma/WASM, routing, auth and Workflow-version guards                               |
| Canonical website Linux/OpenNext build                                                                                                       | PASS: `pnpm cloudflare:web:build`, 608.077 seconds including fresh locked dependency installation; Next compilation 77 seconds; 61 static routes, Wrangler dry bundle and actual final-artifact workerd liveness/login/static checks |
| Live providers, real payments, real R2 and Cloudflare scheduling                                                                             | NOT_RUN; no paid calls were made                                                                                                                                                                                                     |

The initial browser failure was a test locator matching both the visible error and
Next's route announcer; scoping it to the template error fixed the test. The first
native Workflow regression exposed ordinary jobs entering the new optional prepare
service; the production branch now requires the explicit template checkpoint, and
both ordinary timeout/early-event paths pass again. Before final packaging, updated
main was merged rather than discarding its callback and pricing changes.

The first Linux packaging run was intentionally stopped while installing dependencies
because it snapshotted the older main. Its manifest records exit 137 and confirmed
container removal; it is **superseded, not passing build evidence**. The final run
uses the merged production source. Dependency download time is not generation latency.

## Timing evidence

Admin diagnostics expose actual persisted stage timestamps and nonnegative durations:
request/reservation, input review, scene POST/acceptance/provider completion/storage/review,
derived-input seal, video POST/acceptance/completion/storage/review, final READY.
Missing or inverted observations return null, not zero. Provider wait, transfer, review
and scene-to-video scheduling are separate. Logs contain identifiers and controlled
codes, never prompts, photos or signed URLs.

Real segment times and admission P95: **NOT_RUN**. Unit fixture clock differences are
not cloud performance measurements. Local command duration belongs only to local
verification and must not be represented as generation latency.

The final SQL/HTTP-fixture run measured 1,066.58 ms for a complete synthetic flow and
1,057.54 ms for a scene-commit-response-loss recovery. These include loopback SQL and
controlled transport responses, not model generation or cloud performance. Raw
per-step times and explicit limitations are preserved in
`docs/implementation/hotel-lobby-local-evidence.json`. No sub-second real admission
claim or real latency percentile has been established.

The merged-source background bundle is 6,095,313 bytes with SHA-256
`86410a4166506ec2bdbe8b2063b6a856bb07457636e6689ec9942966a431dc12`.
Its Prisma WASM SHA-256 is
`c9f94b7945f5681a74403e9148cf67434462cccea6035d2ee29ad593f5f74a25`.

Website artifact: `.cache/cloudflare-web/linux-fQ3EYQ/artifact`, closed local binding
template, source manifest and build manifest retained. Its main Worker SHA-256 is
`bbffc8b6e5e524767635567ce87f59ecfc08877b702be11fe081afa5f6d4b48c`.
After the build, all snapshotted application/runtime files matched current hashes;
later changes were tests, API type-library configuration and delivery documentation.
The website artifact smoke did not test concurrent PostgreSQL queries; that flag is
false in its receipt. The separate jobs artifact smoke exercised the local database.
Bundler dependency warnings and missing build-only social OAuth credentials did not
fail compilation; no live OAuth acceptance is claimed.

## Git publication and cleanup

The initial feature branch and draft [PR 17](https://github.com/Micmyw/ez-image-ai/pull/17)
were published at `69611e6d`. Its first CI run passed quality, production builds and
dependency/secret scans but failed the final database invariant and homepage resource
budget. These failures were real and are retained as historical evidence.

Repair `e919ee7e` precisely cleans five deliberately invalid callback fixtures after
the negative SQL test; it does not weaken the invariant. On a fresh local PostgreSQL
17.11 database all 62 migrations applied, the 23 template cases passed, and all ten
invariants reported zero violations. The pre-fix single test passed but left exactly
the same invariant violation as CI, establishing the regression.

The browser repair scopes detailed template translations to its route and removes
schema imports from shared payment-return navigation. The unchanged homepage budget
now passes locally at 532,322 gzip bytes against an exclusive 532,480-byte limit
(previous CI: 534,508). Thirty-four focused unit tests and eight production browser
cases passed; production build plus browser checks took 110.571 seconds. Final remote
CI remains authoritative because the local headroom is only 158 bytes.

After merging current main, the concentrated unit/Mock command passed 1,242 tests in
73 files, in 43.688 seconds. Configuration/deployment focused runs passed 91 and 150
tests respectively; these overlap the concentrated run and are not added to it.
The dedicated template markup is 20,000 bps, with an approved payment basis and at
least 750 bps payment budget, without changing ordinary video pricing.

Final Git/CI outcomes are recorded against the final revision in the delivery reply.
Main push can trigger the existing two Cloudflare builds; their read-only migration
preflight refuses to deploy when the new additive migration is pending. No automatic
build result is treated as real template acceptance. Public examples, indexing and
paid template admission remain closed regardless of Git/CI success.

Temporary browser, verification and workerd processes are stopped. Both Linux build
containers confirm removal. Disposable PostgreSQL/MinIO fixtures are removed after
verification; source, local logs/screenshots and packaged artifacts remain in the
unmerged app-managed worktree for review. No shared user-started service is stopped.

## Deployment order and rollback

These are instructions for a separately authorized release; they were not executed.

1. Verify intended repository SHA, target database migration history and private worker
   policy without exposing credentials. Keep template admission false and content draft.
2. Apply the additive migration using the existing controlled Prisma migration procedure.
   Retain the latest multi-model pending-quote fix and original inputSnapshot trigger.
3. Deploy the compatible background receiver/native Workflow, scene callback handler,
   private storage and cleanup support, then the website/API. Verify the actual
   deployed artifacts; local builds are not deployments.
4. Verify packed/flat policy agreement on both Workers, approved prices/expiry, model
   allowlist and private media CORS. Grant only the separately authorized internal
   acceptance cohort and paid budget.
5. Run the bounded real quality/recovery/ledger acceptance. Preserve any uncertain paid
   attempt and stop new paid tests until it is reconciled. Publish only rights-cleared
   product examples from the accepted template version.
6. Open public generation/indexing only after its independent product, pricing and
   content gates pass. A later short provider outage disables generation without
   removing an already-published canonical page from search.

Rollback closes new template admission on both Workers first. Preserve already
accepted frozen versions, sidecars, callback routes, reservations, cleanup and recovery
until they are settled or manually reconciled. Keep the additive schema. Never reset
a scene paid fence, overwrite a derived input, delete unsettled sidecars, move template
jobs to the legacy engine, or release uncertain credits/physical storage in bulk.
Ordinary image and video work continue on their original contracts.
