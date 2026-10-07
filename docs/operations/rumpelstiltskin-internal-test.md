# Rumpelstiltskin internal reference-video test

Status: development only, disabled by default. This change prepares code and a migration; it does not approve a production launch, execute a migration, deploy, or authorize any paid provider call.

## Execution contract

An authenticated, explicitly listed tester uploads one JPEG/PNG/WebP portrait through the existing sealed video upload path. The internal left/right role bindings must identify the same immutable asset. Waffo reviews the actual motion prompt once, and SeeAPI reviews that portrait once; the reviewed result is bound to both roles without another review request. No scene image is generated or reserved.

The schema 2 snapshot freezes `rumpelstiltskin-solo`, a five-second/720p/9:16/silent Seedance 2 request, the versioned prompt, and a backend-selected motion manifest. The supplier receives `reference_image_urls` and `reference_video_urls`, with audio generation disabled. The reference is not a first frame and the client cannot supply or override its key/URL. The existing native `VIDEO_WORKFLOW`, credit reservation, pre-send database fence, uncertainty hold, provider retrieval, output transfer/review, finalization and private download flow remain authoritative.

The prompt asks the left/main performer to use the uploaded identity while preserving the second character and the reference's toe-stepping motion. Reference generation can still alter faces, the second character or motion. These requests are test requirements, not quality evidence. No song or competitor clip is bundled, and no 1987-film-origin claim is made.

## Admission and private configuration

- `VIDEO_V1_ENABLED=true` and `RUMPELSTILTSKIN_ENABLED=true` are independent prerequisite switches. The new switch defaults to false. No new build enable override is provided.
- `RUMPELSTILTSKIN_ACCESS` accepts only `internal`; `RUMPELSTILTSKIN_ALLOWED_USER_IDS` is an independent nonempty tester list. An admin role alone grants no test access.
- `RUMPELSTILTSKIN_ACCEPTED_TEMPLATE_VERSION` must match the accepted schema 2 version. The existing model allowlist must separately permit Seedance 2 / image-to-video / 5s / 720p / silent. The internal execution kind differentiates reference mode from ordinary image-to-video billing.
- `RUMPELSTILTSKIN_APPROVED_MOTION_REFERENCE` and `RUMPELSTILTSKIN_COST_APPROVAL` are separate private server bindings, each limited to 5,000 UTF-8 bytes. They are not public variables or additions to the existing 5,000-byte policy pack. Website and background workers receive the same private bindings; hydration clears stale values.
- `.env.local.example` contains disabled settings and empty approval fields only. Synthetic test fixtures are not valid assets or approvals.

Missing or invalid material/cost approval returns a safe blocked reason before capability quotation, balance lookup or generation. Admission and first paid submission revalidate database facts, not only an environment JSON assertion. Closing new admission preserves owner-scoped historical state, playback and download.

## Motion asset preparation still required

There is no approved motion asset in this change. Obtain an original or licensed, silent motion scene with the desired stepping sequence and second character. Do not extract competitor video, music or other unlicensed assets.

Trusted operator preparation must seal a private admin-owned video as a `MediaAsset` with current `READY` status, immutable checksum/object key/ETag/storage version, measured byte count, MP4 type, duration, dimensions, fps and no audio tracks. Supplier limits are enforced by `approvedRumpelstiltskinMotionReferenceSchema` (at most 50 MB, duration 2–15s, fps 24–60 plus dimension/ratio limits).

The database must also contain actual current SeeAPI `OUTPUT` approval for those bytes and verification generation, including the complete sampled-frame evidence accepted by `hasVideoApproval`. Its raw envelope must contain `rumpelstiltskinReferenceApproval` with `version`, measured `fps`, `audioTrackCount:0`, and a manual `rights` receipt (`approvalId`, `validUntil`). The manifest's `review.decisionHash` is the canonical envelope hash produced by `fingerprintVideoTemplateReferenceApproval`. Copying an `ALLOW` string into an environment variable cannot satisfy this gate. The fixed asset is excluded from consumer job-asset bindings.

Prepare this material through a trusted ingestion/review process before enabling the test. This implementation adds no public reference-upload or rights-approval endpoint and no new permission subsystem.

## Budget and quality gates

Before a paid trial, present an explicit maximum total budget and obtain approval. Supplier cost must include the actual reference-video duration plus the requested output for the selected reference mode. `RUMPELSTILTSKIN_COST_APPROVAL` requires a separately dated, expiring provider cost bound to reference version/duration, plus subject/reference/output review, actual prompt review, runtime, storage/transfer, payment allocation and failure allowance. Hotel Lobby's 69-credit approval and ordinary first-frame tariff cannot be inherited. No real budget has been approved or configured here.

The required contribution profit is at least 200% of complete operating cost: `(net revenue - cost) / cost >= 2`, or `net revenue >= 3 * cost`. Here net revenue is the actual discounted receipt after payment fees; operating cost includes generation, reviews, runtime, storage/transfer and expected failures/retries. This is contribution profit, not company net profit. Unknown merchant rates, failure rates or review prices require explicit dated assumptions and later receipts; they are not verified costs.

The approval must include `revenue.minimumGrossUsdMicrosPerCredit`, its dated `basis`, and `validUntil`, derived from the lowest currently purchasable receipt divided by all issued credits, including annual grants, subscriber bonuses and discounts. Payment fees are deducted separately. The reader rejects an approved floor above the current cheapest catalog unit revenue (currently 21,944 USD micros per credit); a verified lower discount floor raises the quoted credits. The frozen funding policy applies the same floor to actual paid receipts. Free credits or insufficiently funded discounted credits cannot silently qualify. The quote freezes net revenue, risk-adjusted operating cost and contribution profit, and rejects a profit ratio below 200%. The existing conservative solver may require more than the minimum. Missing or expired revenue evidence keeps admission closed.

Use authorized portraits to assess recognizable identity, toe-stepping action/timing, preservation of the second character, shot continuity, defects and actual charged cost. A generic dancing output does not pass. If direct portrait input fails, propose a separately budgeted scene-preparation change. Publish real samples or open charging only after acceptance evidence and explicit rollout authorization.

## Migration and verification boundaries

`packages/database/prisma/migrations/20261007190000_rumpelstiltskin_reference_template/migration.sql` extends the existing template CHECK and immutable triggers for schema 2 without new tables, grants or browser permissions. It preserves schema 1 protections. It has been prepared only; no database migration was executed.

Local tests use synthetic assets/approvals and injected provider mocks with real credentials scrubbed and external HTTP blocked. They validate request shape, immutable evidence binding, single submission, uncertainty recovery, accepted-task settlement after reference expiry/deletion, account gating, private configuration transport and legacy behavior. They do not certify production SQL execution, paid supplier acceptance, visual quality, live Cloudflare recovery or a browser session backed by a real account/database.

For closing a future trial, set `RUMPELSTILTSKIN_ENABLED=false`; keep the receiver, private stored results, owner-scoped history and accepted-task recovery running. Do not edit frozen snapshots, resubmit ambiguous attempts, or refund accepted work merely because current reference approval has expired.

## Local entry and current PostgreSQL blocker

The account route is `http://localhost:3000/video/effects/rumpelstiltskin` with the SaaS development server. It requires a local verified account; normal signup sends a verification email. With the default disabled switch it returns 404. For a blocked internal preview, list the exact test user and enable the prerequisite access switches while leaving the two approval fields empty. Do not fabricate an approval merely to get past this state. Existing owned jobs remain available through the validated history route after generation is closed.

Dependencies and generated Prisma clients are already available in this checkout. Before `pnpm dev`, prepare a disposable local PostgreSQL database and a local `.env.local` whose `DATABASE_URL` identifies it. The compose example's `POSTGRES_DB=supastarter` and example URL ending `/ezpic` must be aligned explicitly. No real `.env.local` was copied here. Ordinary Node/Next development does not supply native `VIDEO_WORKFLOW`; it can verify authentication, blocked admission and history, but is not a complete video execution environment.

The installed Docker Desktop was started hidden through approved process execution, but its Linux engine remained unready. The bounded readiness probe timed out and its recent local status reported `Virtualization:false` and `State:stopped`. No security or virtualization settings were changed. No image was pulled, no test database was created and no migration was applied. Docker engine readiness is the immediate observed blocker; cached PostgreSQL image availability, a disposable port and the full SQL run remain unverified. A standalone PostgreSQL executable/service was not found by the focused checks.

Safe mock regression is reproducible from this worktree with `node ..\verify-rumpelstiltskin.mjs config saas api jobs`. Real PostgreSQL coverage is prepared in `packages/database/prisma/queries/media/rumpelstiltskin-reference.integration.test.ts` (five cases), guarded to require a loopback test database. Run it only after migrating that disposable database, together with the existing legacy template integration tests. The mock runner deliberately uses an unused database port and cannot run this gate.
