# Seedance price basis local verification — 2026-10-07

This receipt records the original local implementation phase of the supplied
`seedance-pricing-plan-2026-10-07.md`. At that checkpoint, no Git publication, production
configuration change, deployment, account-billing read or paid generation was authorized or
performed. The user's subsequent request authorizes merging this change into `main` and pushing
it; Git and CI results belong to that later publication receipt. Public supplier reads are recorded in
[the refreshed price basis](video-v1-price-basis-2026-10-07.md).

## Checkout and scope

- Repository: `Micmyw/ez-image-ai`; implementation base `bc9ef8bc886511887bb752999e2b3f5ac3cf63e6`.
- Attached app-managed worktree: `C:\Users\梅一伟\.codex\worktrees\seedance-price-basis\ez-image-ai`;
  branch `codex/seedance-price-basis`; intended future integration target `origin/main`.
- The supplied plan used `fc4040b4efe18cf4e0901491bf55e8ab34a51a0e`. The newer base includes
  Raindance templates sharing the same video price basis. Their own budgets and access policy are
  unchanged; the future configuration handoff covers all shared callers.
- The original `D:\AIProject\Gefei\SaaSTool\ez-image-ai` checkout started at
  `569bf39eea9dcf072d3c5e5f79d58cd38d6bb466` with 381 Git status records. This task did not edit,
  reset, stage or commit those source changes. During execution, a separate checkout operation
  moved its `main` to `bc9ef8bc886511887bb752999e2b3f5ac3cf63e6` (reflog: 2026-10-07 23:39:52
  +08:00); the later read-only status was clean. This task's implementation remains in the attached
  worktree and has not been incorporated into that checkout.

## Changes

| Files                                                                                                                                        | Result                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/config/video-pricing.server.ts`, `video-pricing.test.ts`                                                                           | New `kie-public-2026-10-07.1` basis removes only the superseded Mini/Fast cutoff; preserves four tariffs, arithmetic, finite operator deadline and approval matching.    |
| `packages/api/modules/video-v1/catalog.test.ts`, `packages/config/video-effects.server.test.ts`                                              | Fixed-clock regressions for renewed approval, 96 combinations per model, allowlist restriction, global closure, old approval rejection and unchanged Hotel Lobby policy. |
| `apps/saas/modules/video-v1/{model.ts,model.test.ts,VideoWorkspace.tsx,render.test.tsx}`                                                     | Definite changed/expired prices clear rejected quotes, refresh catalog and require another review/confirmation; lost responses retain the original receipt.              |
| `packages/i18n/translations/{en,de,es,fr}/saas.json`, `apps/saas/content/docs/video-beta.mdx`, `CHANGELOG.md`                                | Localized price-unavailable message and user guidance.                                                                                                                   |
| `docs/product/video-model-pricing.md`, `docs/operations/video-v1-configuration.example.env`, current Hotel Lobby example/config-tool fixture | Current compatible source and example versions; no runtime approval, template-policy change or expiry extension.                                                         |
| `docs/operations/video-v1-price-basis-2026-10-07.md`, `docs/operations/evidence/video-pricing/seedance-*2026-10-07.*`                        | Minimal public observations and a separately generated conditional 192-tuple reference; historical evidence stays intact.                                                |

Additional changed sources: `apps/saas/modules/video-v1/video-v1.e2e.ts` adds the browser
rejections/reconfirmation checks; `docs/implementation/video-v1-file-map.md` points to the new
source; `docs/operations/hotel-lobby-configuration.example.env` and
`tooling/scripts/prepare-hotel-lobby-config.test.ts` retain the existing template costs while using
the matching shared price version. The new evidence consists of `seedance-public-2026-10-07.json`,
`seedance-reference-2026-10-07.ts` and `seedance-conditional-reference-2026-10-07.json`.

## Verification

Checks use the isolated checkout without `.env.local` or production credentials. Test subprocesses
load `tests/video-v1/no-paid-network.mjs`, which blocks non-loopback provider/moderation traffic.
Public pricing retrieval happened separately. Browser verification may allow read-only public font
downloads; no generation, billing or moderation endpoint is allowed.

| Check                                                                                                             | Result                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Baseline config pricing/effects tests                                                                             | 40 passed before the price tests changed.                                                                                      |
| New config regressions against old code                                                                           | 10 failed and 38 passed; failures demonstrated superseded cutoff and version mismatch.                                         |
| New catalog regressions against old code                                                                          | 2 failed and 10 passed; failures demonstrated missing renewed pricing and old-version admission.                               |
| New UI regressions against old code                                                                               | 9 failed and 24 passed; failures demonstrated missing error classification and localized expiry copy.                          |
| `pnpm --filter @repo/config exec vitest run video-pricing.test.ts video-effects.server.test.ts`                   | 48 passed.                                                                                                                     |
| `pnpm --filter @repo/api exec vitest run modules/video-v1/catalog.test.ts`                                        | 12 passed.                                                                                                                     |
| `pnpm --filter @repo/jobs exec vitest run src/video-v1/admission-pricing.test.ts src/video-v1/submission.test.ts` | 56 passed; accepted replay bypasses repricing, expired first submission calls no provider, uncertain submission is not resent. |
| `pnpm --filter saas exec vitest run modules/video-v1/model.test.ts modules/video-v1/render.test.tsx`              | 39 passed; four-locale error-key parity passed.                                                                                |
| `pnpm --filter @repo/config --filter @repo/api --filter @repo/jobs --filter saas type-check`                      | All four passed, including Next route types and Fumadocs generation; SaaS passed again after the browser test additions.       |
| Conditional reference generator                                                                                   | All 192 combinations match the Oct 5 historical credits; floor remains 21,944 USD micros per paid credit.                      |
| Changed-file formatting/lint and `git diff --check`                                                               | Passed for all changed source, translations, evidence and the final receipt.                                                   |

Additional completed checks:

| Check                                                                                          | Result                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm hotel-lobby:test-config`                                                                 | 11 passed, after reproducing 8 of 9 original failures caused by the stale shared `.3` fixture. New checks preserve the closed 69-credit example, its original deadline and rejection of old approval.     |
| Focused `video-v1-execution.integration.test.ts` with the integration config and runner loader | 46 passed against fresh loopback PostgreSQL 16.14 with all 64 current migrations and UTC session time. Zero first-submit attempts, exactly-once release and six accepted/uncertain recovery cases passed. |

These checks establish local behavior only; they do not establish live availability or supplier
invoices.

### Database fixture and clock limitation

No Docker daemon was running. Existing immutable PostgreSQL 16.14 binaries were reused with a new
task-owned data directory and database, bound only to `127.0.0.1:56873`; no historical fixture was
reused. Database validation used the repository's safe-target guard and no production credentials.

The first run passed 24 and failed 22 tests because native initialization selected Asia/Shanghai.
A diagnostic at `2026-10-07T15:41:33Z` showed `pg` reading the correct UTC clock while the installed
Prisma adapter's raw `timestamptz` normalization returned the same wall-clock digits as UTC, eight
hours ahead. Configuring only this isolated cluster to UTC restored correct clock comparison and
all 46 tests passed. This measured pre-existing raw-query behavior remains a verification limit:
the application/database code was not changed, and the production database time zone was not read.

Initial failures, UTC diagnostics and final passing logs are preserved in
`.cache/seedance-price-basis/database-verification/`. The test cluster was temporarily retained for
sequential local browser-auth verification and is now stopped.

### Focused browser behavior

Local Playwright passed **8/8**, with no failed, skipped or flaky cases. Video APIs were mocked;
authentication used one credential user in the isolated local database. The owning config was
`apps/saas/modules/video-v1/playwright.config.ts`, filtered to the changed-price/price-expiry,
double-click/recovery, timeout/reload and parameter-change scenarios in `video-v1.e2e.ts`.
Hotel Lobby, Raindance and unrelated browser specs were not run.

- `PRICE_CHANGED` removes the rejected stored receipt and confirmation, refetches catalog, and
  waits for user review. A new 29-credit mock quote creates no job automatically; only explicit
  confirmation sends the same request with the new quote ID and a new idempotency key.
- Both `VIDEO_MODEL_PRICE_EXPIRED` and `VIDEO_PRICE_EXPIRED`, at create and quote endpoints,
  remove the expired quote/receipt, show price-unavailable text and refresh availability. They
  create no replacement request.
- Lost responses preserve the original request and key through reload, even when the catalog
  has closed and the stored quote TTL has passed. Existing double-click and setting-change
  assertions passed.

Reports, eight traces and inspected screenshots are in `.cache/video-v1/browser-results/` and
`.cache/video-v1/browser-report.json`. The cleanup receipt is
`.cache/video-v1/price-basis-browser-verification.json`. Browser Mock PASS is not real supplier,
moderation, storage or invoice acceptance.

### Process cleanup and independent review

The browser driver deleted its one credential user. All 19 original browser/Next process identities
exited and port 3349 closed; a subsequently reused PID belonging to an unrelated process was
preserved. All 68 recorded database/test process identities exited, PostgreSQL was stopped using
its exact owned data path, and port 56873 has no listener. No temporary server or database process
is retained. The cleanup records include creation timestamps to distinguish PID reuse.

Independent review found the current Hotel Lobby example/test fixture's stale version, which was
fixed and verified without auto-approval behavior. It found no remaining actionable patch issue and
independently recalculated all 192 reference rows with zero arithmetic/historical-credit mismatch.

## Conditional old/new comparison

Supplier budgets remain Mini 19,000/41,000 and Fast 59,000/124,000 USD micros per second at 480p/720p.
Under the explicitly recorded Oct 5 cost policy, Mini stays 24–91 credits and Fast stays 44–244.
The conditional reference lists every unchanged tuple; it is not a readback of current production
policy or today's online retail price.

## Publication boundary

At the original local checkpoint, Git commit/push, CI on a new SHA, both deployment targets,
private configuration readback/update, live authenticated catalog availability, account bills and
paid external acceptance were **NOT_RUN**. The subsequent Git publication request does not itself
establish deployment, configuration compatibility or live billing evidence.
Future release must synchronize the existing website and Workflow build/runtime policies with the
new price version and documented cost basis, preserving an existing still-valid operator deadline.
An expired or extended approval requires the operator to supply its deadline and basis.

At local completion, the worktree was retained for review because the changes had not been
incorporated or published. After authorized incorporation and publication checks, preserve the
ignored verification artifacts and archive this app-managed worktree only when clean and inactive.
