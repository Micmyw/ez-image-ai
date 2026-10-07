# Rumpelstiltskin development receipt — 2026-10-07

Development branch: `codex/rumpelstiltskin-seedance2`. HEAD: `bfda2815c02f845edc0220baf9fcaac3faca79a1`. Changes are uncommitted; no commit, remote push, merge or deployment was performed.

Isolated checkout: `D:\梅一伟\Documents\codex\2026-10-07\task\ezimage-rumpelstiltskin`, created from clean `bfda2815` after the independently developed ordinary-video audience change. The primary checkout `D:\AIProject\Gefei\SaaSTool\ez-image-ai` was not edited or reset. It independently advanced through `ff3431ef` to `d3bf24b704b7b2b54ae74188f03974ff7a8eb467` during this work. Read-only comparison found overlap in configuration, website bindings, video admission/execution, API tests and translations. This receipt does not certify integration onto that later main; its ordinary-video public pricing/access policy must not replace the new reference feature's independent closed approval and 200% contribution-profit requirement.

## Delivered

- Private authenticated `/video/effects/rumpelstiltskin` entry, independent internal allowlist and default-closed switch. One portrait upload; no front-end motion URL/asset selector, public discovery link, real-result sample or credit-purchase promotion.
- Seedance 2 image/video-reference adapter and immutable schema 2 template. Direct mode reviews one actual prompt and one subject, without scene-image generation. Existing schema 1 Hotel Lobby and Raindance behavior is retained.
- Frozen admin-owned motion identity, complete database SeeAPI/rights approval binding and independent expiring full-cost approval. Absent approval closes quotation/submission. Private manifest/cost bindings are mirrored across website/background workers without enlarging the shared runtime pack.
- Required dated revenue evidence uses the lowest purchasable receipt per all issued credits, including annual grants, subscriber bonuses and discounts. Payment fees are deducted separately. The quote records net revenue, risk-adjusted operating cost and contribution profit, and requires `(net revenue - cost) / cost >= 2`. Missing/expired evidence, below-target markup, or an approved unit-revenue floor above the catalog minimum blocks admission. No merchant receipt or trial budget is invented by the code.
- Existing task/reservation/submission fence, uncertain acceptance hold, output review, settlement, owner-scoped playback/download and historical recovery. Reference expiry/deletion stops new paid submissions while preserving accepted-task settlement.
- Additive SQL migration prepared; no migration applied. Four-language test copy and operation instructions added.

## Passed local verification

Every verification subprocess scrubbed real credentials and preloaded `tests/video-v1/no-paid-network.mjs`. Unit database URL was an unused loopback port; provider behavior used injected mocks. Paid generation calls: **0**.

| Scope                                                              | Test files | Passed cases |
| ------------------------------------------------------------------ | ---------: | -----------: |
| Configuration, approval, access, output, runtime transport         |          6 |          137 |
| Provider request contracts and uncertainty                         |          3 |           84 |
| Database reference binding and settlement mocks                    |          1 |           22 |
| Video jobs, preparation, admission, submission and legacy recovery |         19 |          291 |
| Template API                                                       |          1 |           29 |
| SaaS effects, account page, history and locale parity              |          7 |          110 |
| Website configuration preparation                                  |          3 |          198 |
| Workflow runtime and orchestration                                 |          2 |           39 |
| **Total**                                                          |     **42** |      **910** |

- TypeScript checks passed for `@repo/config`, `@repo/ai`, `@repo/database`, `@repo/jobs`, `@repo/api`, `@repo/web-host`, `@repo/workflows`, and `saas`. Next/Fumadocs route types were generated before the SaaS check.
- Focused Oxfmt, Oxlint and `git diff --check` passed for modified/new source files.
- `@repo/workflows build:workers` passed with explicit Wrangler `--dry-run`. Final `dist-workers/workers.js` started in actual local workerd; unsigned requests, invalid signed tasks, executor routing and video Workflow/version guard checks passed. No live Cloudflare deployment or database query was performed by this smoke test.
- Independent read-only review found a closed-generation historical-page regression and a scene-stage label mismatch. Both were fixed and rechecked. The new output-contract test also found and corrected the legacy Seedance 1.5-only restriction.

The reproducible local runner is `../verify-rumpelstiltskin.mjs` in the delegated task directory. Individual raw logs are retained in ignored `.cache/rumpelstiltskin-verification/` in this checkout. Initial sandbox child-process `spawn EPERM` was resolved using approved escalation with the same credential scrubbing and network guard.

## Not run and remaining gates

- Real PostgreSQL migration/trigger integration: **not run**. Five additional real-PostgreSQL tests are prepared in `packages/database/prisma/queries/media/rumpelstiltskin-reference.integration.test.ts`; they cover idempotent admission, one-image review/finalization, SQL approval/immutability guards, owner/rights denial and zero reservations on refusal. They have not been executed. The 22 transaction tests above are mocks and do not substitute for this gate.
- Docker readiness: the installed `C:\Program Files\Docker\Docker\Docker Desktop.exe` was started hidden through approved execution. Backend processes appeared, but Docker IPC/version requests did not complete; a bounded 20-second status probe timed out. Only those diagnostic sessions were canceled. Recent local engine status included `Virtualization:false` and `State:stopped`; this is an observed status, not a proven BIOS diagnosis. No security/WSL/virtualization settings were changed, no image was pulled, no database/container was created and no migration was run. No standalone PostgreSQL executable/service was found in the focused checks. The immediate blocker is an unready engine; image availability, a disposable port and SQL correctness are separate unverified gates, so Docker is not proven to be the only blocker.
- Full SaaS/OpenNext packaging and authenticated browser session with a real database: **not run**. Component/page permission tests and route/type generation passed.
- Actual Seedance 2 acceptance, likeness, toe-stepping fidelity, fixed second-character preservation and actual provider charges: **not run**. There is no original/licensed approved reference asset, persisted approval receipt, real cost approval or paid-trial budget in this change.
- Production migration, deployment, merge, public launch and remote push: **not performed**.

Keep the test closed until the authorized material is prepared, SQL is tested on disposable PostgreSQL, and an explicit bounded paid-trial budget is presented and approved. The paid outputs must pass the quality checks in [internal-test instructions](./rumpelstiltskin-internal-test.md) before any public charging or sample publication.

## Minimal local review

From this isolated checkout, `node ..\verify-rumpelstiltskin.mjs config saas api jobs` reproduces safe mock checks with provider networking blocked. Dependencies and generated clients already exist. For a browser preview, first prepare a disposable local database, align its name with a local `.env.local`, and obtain a local verified account; then run `pnpm dev` and visit `http://localhost:3000/video/effects/rumpelstiltskin`. Default access is closed (404). An explicitly listed tester may view blocked admission with prerequisite access switches enabled and both approval fields left empty. No live secret file was copied. Normal Node/Next development lacks native `VIDEO_WORKFLOW` and cannot certify the complete paid execution path. Detailed prerequisites and the pending SQL test are in the internal-test instructions.
