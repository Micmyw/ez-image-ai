# Ezrapvideo template integration implementation plan

**Goal:** Integrate source video templates into EzPic using the source prompts, original reference assets and source generation contracts.

**Architecture:** Reuse existing public navigation, template UI primitives, private media, financial admission and native VIDEO_WORKFLOW. Source-specific request construction is copied with provenance and adapted at the provider boundary; no replacement prompts, scenes, models or generation stages.

**Tech stack:** Existing Next.js, next-intl, oRPC, Zod, PostgreSQL and Cloudflare Workflows. No new dependency unless unavoidable.

**Spec:** `docs/product/ezrapvideo-template-integration-design-2026-11-06.md`.

## Constraints and execution decisions

- User authorized local implementation after design and explicitly required direct code/prompt/material reuse. No push, deployment, real paid generation, live configuration mutations or new content creation.
- Working checkout: `D:/AIProject/Gefei/SaaSTool/ez-image-ai`, branch `codex/ezrapvideo-templates`. Only the task's design was untracked at start. Source repository `../ez-airapvideo` is read-only; its unrelated untracked designs remain intact. No new worktree needed for this otherwise clean checkout.
- Use focused parallel ownership under subagent-driven-development for source preservation, backend admission/runtime, and frontend. Parent owns integration, validation and docs. No subagent commits. User working agreements supersede repeated per-task reviews and mandatory workflow pauses; use one independent integrated review after focused checks.
- Prompt/scene/audio bytes and semantic generation request match the actual source. Record source commit + SHA256. Effective saved source configurations may differ from sample JSON; missing configuration is unavailable, not guessed.
- Preserve current Hotel Lobby, Raindance and Rumpelstiltskin IDs, frozen requests and authority. Source Hotel Lobby is a separate identity.
- Public product keys only; no prompts, raw provider contracts or private reference URLs in client bundles.
- API prices and availability must be server-authoritative. Do not copy the source's credit unit conversion into EzPic without explicit pricing configuration.
- Existing transactions, idempotency, immutable financial records, private media validation, moderation and unknown-submission protection remain mandatory.
- SaaS Vitest, Next/Fumadocs generation and browser checks run sequentially. Track/clean task-owned process trees.

## Review focus

1. Missing/placeholder source configuration must not be treated as ready or replaced with newly generated material.
2. Multi-person reference ordering and source-specific audio/endpoint must survive integration unchanged.
3. Unknown/duplicate submissions must preserve the same intent and credit reservation, including across template switches.
4. Public catalog/cache must exclude prompts, private media and account data; private asset handoff must reauthorize owner.
5. Old template jobs, paths, admission and history must remain compatible when new templates are disabled.

## Work packages

- [x] Source preservation and provider construction: copy original JSON/prompt assembly and minimal pure dependencies into `packages/ai/media/rap-templates`; record checksum manifest and original private asset inventory. Build exact SeeAPI/Kie requests and bounded transports, with tests adapted from source. Report placeholders and missing assets without generating replacements.
- [x] Public catalog and client request contract: `packages/config/video-template-library.ts`, exported through package.json. Include seven source effects, Original Rap/four styles, existing EzPic entries, and legacy Flying Car inventory status. Canonical paths and no private data.
- [x] Backend integration: existing video job/quote/execution/fulfillment infrastructure plus new `/video-templates` oRPC surface. Frozen source contract, multi-role private inputs, independent config and pricing readiness, provider-specific submission/retrieval. Add deterministic provider and financial/admission regressions. Preserve old paths and accepted replays.
- [x] UI integration: `/video-templates` and `[slug]`, reusable poster-first directory and source-shaped workspace, one active preview, owner-scoped drafts, explicit availability/pricing, existing uploads/quotes/job/results/history. Navigation, image result handoff, public indexing and translated content.
- [x] Source effective configuration audit: read only actual source configuration if available through its supported environment; do not expose credentials. Prepare a safe import/provisioning path for references/configuration without changing production.
- [x] Integration validation: affected format/lint/type checks, provider/request preservation tests, API and state tests, source hash inventory, public routing/performance and relevant browser journeys. Fix introduced failures; no paid provider calls.
- [x] Independent final review; update CHANGELOG, design/status notes and actual blockers. Report local, CI and live evidence separately.

## Evidence ledger

- Initial checkout contained only the task design doc as untracked. Source HEAD observed `75c06e3`; implementation provenance uses full commit and individual file hashes.
- Source Green Booth and pet sample JSON contain explicit placeholders; effective config must be checked separately.
- Existing source H3/SeeAPI generation contracts cannot be replaced by the target's narrower Seedance motion-reference adapter.
- Read-only source D1 audit found the actual enabled effective 58th Floor/Green Booth/Kung Fu Cat/Paws configs; Bulin uses its actual default. Source credentials were not printed or copied into tracked files.
- All 19 current original reference materials were copied unchanged and hashed. Private originals plus legacy Flying Car inventory total 44,045,146 bytes. Source core validation: 160 tests, affected AI type-check/format/lint passed (source-contracts report).
- Source role-review support: 127 focused DB/jobs unit checks passed; these use mocked storage/provider boundaries and do not certify live integration.
- Private provision transport changed to existing versioned RuntimeConfigOverride per template because a full manifest would exceed Cloudflare binding size limits. Quotes freeze the selected provision and accepted work drains independently of mutable configuration.
- Offline preparation tool wrote `.wrangler/source-video-templates/prepared-2026-11-06.json`: 12 disabled/internal records, 19 verified original current materials (38,017,757 bytes), no invented target prices/rights/reviews, no network/database/provider actions. Its local regression passed.
- Task-owned PostgreSQL 16.14: PID 37920; data `.cache/ezrapvideo-template-integration/pgdata`; loopback 55432; UTC; database `ezpic_source_template_test`. Existing 78 migrations applied before real new-admission tests. Parent owns cleanup.
- Real SQL tests discovered the old quote-evidence CHECK constraint needs an additive explicit source-template branch; backend is adding the migration before rerunning.
- Source-material download process PID 32944 exited; no running process found at verification. No worktree was created.
- Final SQL: `video-source-template.integration.test.ts` 6/6 and existing `video-v1` integration tests 127/127 passed after migration. These exposed and fixed the old CHECK constraint, JSONB fingerprint ordering and omitted text-only identity field; no mocked assertion substitutes for these transaction checks.
- Backend focused unit suites: source DB 10, source jobs 11, source API 6 + existing effects API 36, config/output 17 passed. Database/jobs/API type checks passed. AI source tests 160 passed. Numbers identify separate reported scopes; do not sum earlier overlapping runs.
- Final SaaS run: seven focused files (draft, payment return, existing effect model, indexing, navigation, proxy, sitemap), 113/113 passed. Generated route/docs type check passed earlier; final direct `tsc --noEmit --incremental false` passed after implementation fixes.
- Browser: `video-templates.public-routes.spec.ts --project=public` 7/7 passed. Exercises poster-only initial loading, single explicitly started preview/close, private asset login return and 320/390/768/1440 layouts. Original public poster bytes were locally staged because proxy DNS triggers Next's private-IP protection; this is fixture-backed UI evidence, not production image-optimizer/provider evidence. Screenshots inspected and copied to `output/playwright/ezrapvideo-templates/`. Initial tests caught SSR controls losing clicks; controls now remain disabled until mounted.
- Independent review closed all three findings: async handoff preserves occupied/edited drafts; known non-admission errors provide an explicit proof while unknown outcomes remain recoverable; a bounded 1024-price table supports every advertised exact option tuple. Added a regression for debt appearing after quotation. Reviewer independently checked 47 archived entries with no mismatches.
- Source raw JSON includes CRLF. Added exact `.gitattributes` byte-preservation rules; filtered and unfiltered Git hashes match. All changed code passed scoped lint and format checks; source verbatim records remain excluded from formatting.
- PostgreSQL root PID 37920 and all six recorded children exited after graceful shutdown. Browser launcher/child processes exited and ports 55432/3349 are closed; cleanup evidence is `.cache/ezrapvideo-template-integration/cleanup.json`. No task server or worktree remains.
- Publication/live boundary: no commit, push, deployment, target production config writes, paid generation or live acceptance test. All new source provision records remain disabled/internal and require actual target private asset approval and pricing. Source Hotel Lobby's unknown output contract and legacy Flying Car inventory remain explicitly unavailable.

## Empty-preview follow-up (2026-11-06)

- Queried Airap R2 prefixes and D1 config names/task aggregates read-only, then checked the original static asset declarations. Flying Car's three original poster/video pairs return HTTP 200; the selected curved-ramp poster and MP4 match the source checkout byte-for-byte. Public URL/hash details are in the integration operations document.
- Reused that original sample in the directory and Flying Car detail. The remaining three EzPic tools have compact searchable/filterable links instead of blank preview cards. The directory now contains nine actual sample cards; the existing tool routes and all generation policies remain unchanged.
- Focused validation: catalog tests 4/4, SaaS TypeScript, changed-file lint/format and diff whitespace checks passed. Browser regression 8/8 passed, including all nine decoded posters, one active video, unavailable Flying Car generation, existing routes, private-image handoff and 320/390/768/1440 layouts. The first browser run encountered a development API compilation timeout; the final run isolates unrelated shared-navigation catalog/analytics reads with local fixtures. Poster fixtures are exact source bytes, not generated artwork; these checks do not certify production delivery or generation.
- Updated screenshots: `output/playwright/ezrapvideo-templates/preview-fix-directory-1440.png` and `preview-fix-directory-390.png`. Temporary test process ownership and exit evidence: `.cache/ezrapvideo-template-integration/preview-fix-cleanup.json`. No deployment or source database/storage write was performed.

## Source and credit audit follow-up (2026-11-06)

- User requested prompt/reference, generation and billing checks while explicitly prohibiting real generation. Source and credit reviews plus guarded local tests are documented in `docs/operations/ezrapvideo-template-audit-2026-11-06.md`.
- Source checks: 38 archived material hashes/lengths, six effective prompts, 14 visually inspected current images, five audio durations and 6,984 offline option combinations. Fixed-source comparison preserves unrelated current source checkout edits.
- This audit's non-overlapping unit scopes total 235 passing cases. The admission/execution/fulfillment/source SQL scopes total 232 passing cases after correcting the isolated database timezone to UTC and rerunning the four affected failures. New tests exercise preserved Spin references through actual SQL claim/recovery and source Original Rap through final review and one-time settlement.
- Database TypeScript, both changed tests' format/lint and diff whitespace checks passed. No new business-code fix was needed. No paid generation, external moderation request or production write occurred.
- Twelve target provisions remain disabled/internal pending actual target prices and private reference approval/bindings. Source Hotel Lobby and legacy Flying Car retain their specific contract/execution limitations. Bulin's source prompt mentions audio replacement but its copied source path only supplies reference audio; post-generation soundtrack replacement is not implemented.
- Task-owned PostgreSQL PID 48316 and all six recorded descendants exited, as did all test runners; port 55432 is closed. Cleanup record: `.cache/ezrapvideo-template-integration/audit-cleanup.json`. No publication or new worktree.

## Completion after source-contract correction (2026-11-06)

- Corrected the initial audit: provider-owned Hotel legitimately omits prompt and requested duration; four Flying Car prompt/asset/request contracts exist in the original source. Implemented both without invented prompts/stages. Bulin keeps the original reference-audio flow and does not require a new mixing stage.
- Implemented private material import, exact target pricing, complete preparation and atomic audited application. Real local PostgreSQL/MinIO imported 38 original files into 45 template references with duplicate/unknown-write/quota checks. Prepared all 16 authenticated provisions with 2,342 prices. Dry-run wrote nothing, apply wrote 16 overrides/audits, replay was unchanged.
- Source/transport 202, pricing/retail 128, configuration 44, jobs 54, MP4 21, source SQL 13, fulfillment SQL 25 and browser 9 passed; root configuration CLI command passed all 17 tests. Separate database/material/frontend checks and affected type/lint/format checks also passed. Do not sum overlapping review/rerun scopes.
- Full evidence and release boundaries are in `docs/operations/ezrapvideo-template-completion-2026-11-06.md`. This supersedes the preceding three migration blockers, without claiming a generated target sample or production release.
- Final cleanup: task PostgreSQL PID 32792, MinIO 356/supervisor 275 and recorded Windows descendants exited; ports 55432/59000/59001/3349 closed. Evidence: `.cache/ezrapvideo-template-integration/completion-cleanup.json` and `completion-minio-cleanup.json`. No task worktree or test service remains.
