# Guest conversion implementation and acceptance — 2026-11-14

## Scope and publication

This records the owner's selected conversion improvements, the separate evaluation of early output presentation, and the later administrator diagnostics/cleanup request. The design and ownership map are in [the design record](../product/guest-conversion-2026-11-14-design.md). The checkout remains on `main` at `ab622e20`; fetching `origin/main` during acceptance confirmed that base was current. The implementation is an uncommitted working-tree change alongside preserved work from other contributors. No commit, push, deployment, production schema/configuration change, actual customer deletion or paid generation was performed in this round.

## Implemented behavior

- Guest file selection normalizes supported images, begins a bounded private upload and seals a durable input-review intent before Generate. Prompt changes do not create another upload; replacement images keep independent identities and ignore late UI responses. `SEALED` is not moderation approval. Unknown network outcomes retain the same identity rather than automatically starting another upload or provider request.
- A signed browser identity and permanent private entitlement receipts enforce one identifiable guest trial across MiniMax H3 1K and Nano Banana 2 Lite 1K. Only the explicitly requested network country IN is excluded from new free benefits. Unknown trusted location withholds a new free benefit while retaining login, funded access and historical balances. The existing registered lifetime ten-credit allowance is separate; historical five-credit receipts are not topped up. Frontend feedback does not replace transactional admission and storage limits.
- IndexedDB stores the original file, prompt, public product/SKU, settings and destination through authentication and cancellation, with a one-hour lifetime, at most three drafts and 75 MiB. Owner binding prevents account crossover. Google is prominent, magic-link remains available, and optional One Tap preserves final-session and anonymous-linking behavior.
- Same-object reviews are reused through existing ownership transfer. Private account copies can reuse only current normal SeeAPI approval after exact source/target identity, full byte/checksum validation, leases and immutable copy journals establish provenance. Unknown, expired, changed or abnormal evidence goes through ordinary verification.
- Purpose shortcuts, explicit-model precedence, refine-with-original-settings, relevant Image Pass offers, purchase-time draft protection, format/orientation handling, capability caching and observed-duration estimates are integrated. Duration ranges require enough fresh matching observations; the UI invents no estimate when those are absent.
- Journey diagnostics distinguish selection, upload, click, admitted job, final authentication and genuinely loaded/visible result. Browser observations cannot create server-confirmed events. Consent and privacy controls remain; prompts, files and signed URLs do not enter analytics. Feedback uses the existing support/email flow.
- Administrator content inspection includes uploaded originals, generated images, saved prompts, SeeAPI/Waffo decisions and model messages with explicit provenance. The additional prompt view covers failures without any output or asset. New provider messages are bounded and redacted before persistence; historical absent messages remain absent.
- Administrator cleanup uses an exact preview, typed confirmation, bounded selection and current object revalidation. It queues durable physical deletion; only its successful completion releases storage quota. It preserves financial, moderation, copy-proof and audit records. Optional database deletion is limited to selected internal telemetry older than 30 days. See [the cleanup contract](admin-customer-content-cleanup-2026-11-14.md).

## Output proposals 3 and 4

The new output protocol was evaluated, not enabled or implemented. The [timing evidence](evidence/output-latency-2026-11-14.json) covers 17 matched output assets in a rolling 24-hour window, including internal demonstrations. Finalization-start-to-archive-handoff had P50 5.411 seconds, handoff-to-verdict P50 14.912 seconds, and the independently measured same-task combined interval P50 20.391 seconds. These are observed stage intervals, not pure R2/SeeAPI/SQL time or complete click-to-visible latency.

All 17 observed SeeAPI callbacks arrived after the verdict observation; normal polling found the answer first. Submission-return-to-query-preparation included 5.175–9.987 seconds of waiting and orchestration. This supports investigating poll scheduling and persistence as well as parallel archival. It does not prove that output handling dominates total generation, that low measured result views are caused by latency, or that switching URLs saves a particular number of seconds.

The initial follow-up proposal fetches the candidate once, binds byte identity, creates an immutable review/preview image, and overlaps work with original archival. The later [source-level design review](output-preview-parallel-review-2026-11-14.md) adds essential conditions: separate preview/input/download/settlement capabilities, a selected immutable original matching the preview's source, and explicit original-failure recovery. A durable thumbnail and digest cannot reconstruct missing full-resolution bytes; the safe first version retains the existing complete immutable original object. The current contracts do not prove that the same provider URL serves identical reviewed/displayed bytes, and provider callbacks do not authenticate the whole result body. Raw URL passthrough therefore needs a concrete immutability/access/expiry contract before implementation. Existing authorized job reads already support an approved preview before financial settlement.

## Focused acceptance evidence

Counts below describe separate focused runs and overlap; they are not a combined unique-test total.

| Area                            | Local evidence                                                                                                                                                                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Guest admission and migration   | Fresh disposable PostgreSQL applied 82 migrations; 50 guest-admission integration cases passed, including lifetime identity, exact SKUs, region/replay, concurrent requests and upload slots.                                                                                        |
| Cleanup versus guest completion | Two real PostgreSQL transaction races passed. `pg_blocking_pids` establishes actual waiting; deletion-first cannot return a usable claim, and completion-first prevents deletion atomically.                                                                                         |
| Administrator cleanup           | 14 PostgreSQL cases, 41 database unit cases and 16 API cases passed. API tests run real administrator middleware; storage transport remains a fixture.                                                                                                                               |
| Account-copy review reuse       | 73 PostgreSQL cases, 124 focused database unit cases, 51 Jobs cases, 51 storage transport cases and 32 API cases passed in owning-agent runs.                                                                                                                                        |
| Authentication                  | Auth 50, anonymous-boundary API 44 and deployment-config 16 passed. Three Chromium cases verified login controls, auth mode switching, and a real IndexedDB image/prompt surviving cancelled authentication and refresh.                                                             |
| Guest browser behavior          | Two Chromium cases passed against the actual LandingGenerator: preparation before Generate with the same upload identity; immediate A-to-B preview change and serialized preparation without stale A overwriting B. API, Turnstile, signed upload and handoff are explicit fixtures. |
| Result preview                  | The required real-component Chromium comparison-stability benchmark passed: cached access revocation, owner changes, original-image delays/errors and stable output-node/loading behavior. This is a loopback fixture benchmark, not production latency.                             |
| SaaS integration fixes          | A focused 193-case batch passed; the later StrictMode/locale regression batch passed 24 cases. Administrator presentation passed 12 cases before adding the separate prompt view.                                                                                                    |
| Model diagnostic persistence    | Config 27, AI 134, Jobs 40, database projection 15 and real PostgreSQL 35 focused cases passed. Callback provenance, timeout/uncertainty, rejection billing and manual-recovery behavior were retained.                                                                              |

Prompt-only administrator queries also passed five database unit, five API and four PostgreSQL cases: no-asset failures, rejected prompts without a source asset, parameterized filters, same-time cross-table pagination, quote identity and audited redaction.

Independent review identified and closed browser quota/retry identity issues, optional telemetry failure propagation, recoverable `SUBMITTED` draft deletion, completion-versus-cleanup races, reloadable cleanup retry plans, and Unicode-escaped URL redaction. The review does not establish live provider behavior or conversion uplift.

## Remaining product and release boundaries

- Guest text-to-image still requires sign-in; the new guest benefit applies to image editing. One browser/anonymous identity is not proof of one natural person and does not prevent all device/cookie resets.
- A successful completion response lost after claim-token consumption still lacks a durable response-replay receipt in the existing protocol. The UI preserves the same uncertain submission and original-file login recovery; it does not claim to recover an unseen original claim automatically.
- Native HEIC decoding is used only when the browser supports it; unsupported browsers receive a clear format instruction. No universal HEIC decoder was added.
- One Tap requires a configured public Google client ID and compatible OAuth configuration. No real Google login, payment, live SeeAPI/model generation or live R2 deletion was tested.
- Apply both `20261114090000_guest_lifetime_entitlement` and `20261114090100_guest_entitlement_private` migrations before new guest writers. Preserve permanent receipts when ordinary guest data expires. Verify the deployed app role can select/insert receipts and cannot update/delete them.
- Deploy compatible copy-proof consumers and administrator cleanup consumers before their producers, and drain incompatible runtimes. Keep automatic image deletion paused. Rollback preserves accepted jobs, ledgers, proof journals and queued explicit deletions.
- Deploy the journey reader/ingestion contracts before relying on producer coverage; no new experiment was activated. A later production observation must account for consent, traffic mix, missing coverage, costs, refunds and cohort maturity.

## Reproduction and local resources

Run focused browser coverage with `E2E_GUEST_CONVERSION=true`, a loopback `NEXT_PUBLIC_SAAS_URL`, an explicitly isolated loopback `DATABASE_URL` whose database name includes `test`, and a local `BETTER_AUTH_SECRET`:

```text
pnpm --filter saas exec playwright test --config playwright.guest-conversion.config.ts
node tooling/e2e/src/generation-preview-benchmark.mjs --mode after --comparison-stability-only
```

The browser config owns its Next server and empty session state. SaaS Vitest, Next/Fumadocs generation and Playwright run sequentially. The dedicated guest spec is also assigned to the normal Playwright `guest` project; login specs run in the `public` project without database-auth setup. The preview benchmark records and verifies its Chromium process cleanup. Temporary databases and process cleanup are recorded at final acceptance below.

## Final local acceptance

After integration and the reported corrections:

- All 36 affected SaaS unit/component test files passed, **456 tests**, including the new administrator prompt view.
- The final combined API check passed **50 tests** across administrator content, cleanup, independent prompt queries, generation submission and duration estimates.
- TypeScript passed for API, Database, Jobs, Config, Utils, Auth, AI, SaaS and Web Host. SaaS route/MDX generation completed before its type check.
- Lint passed for all 222 changed TypeScript/JavaScript source files. Formatting passed for all 252 supported changed source/document files after correcting five formatting-only differences. `git diff --check` and `pnpm verify:ci-workflow` passed.
- The last prompt PostgreSQL fixture was changed from a machine-specific database URL to the repository's `TEST_DATABASE_URL` contract and passed all four cases again. No skip was introduced; the existing integration glob includes it and the cleanup/completion race tests. New database unit tests are present in the explicit package test command.
- Independent read-only review completed with no unresolved P0/P1/P2 findings. This is local acceptance, not a production release or conversion-outcome claim.

The task-owned PostgreSQL container `codex-ezpic-guest-20261114` was stopped after all users of it finished. Its container ID and automatically allocated anonymous data volume were verified before removal; automatic removal deleted both. This removed the shared synthetic fixture database and the independent provider-diagnostics database. Guest-admission temporary databases had already been dropped by their owner. No customer database or pre-existing Docker volume was removed.

All tracked browser/Next/type-check processes exited; the preview benchmark also reported no tracked browser descendants remaining. No worktree was created. Docker Desktop and the pre-existing `supastarter-postgres`/`supastarter-minio` services remain running because they are shared pre-existing services, not disposable task resources. When those shared services are no longer needed, use **Docker Desktop → Quit Docker Desktop**; this report does not authorize stopping other work that may be using them.
