# Video follow-up: multi-model implementation and verification

> **Historical scope; superseded runtime (2026-10-04).** The later instruction retires
> all Sightengine calls, selects Waffo prompt review and retains native sound with
> `audioSafetyPolicy={schemaVersion:1,mode:'not_requested'}`. No audio-review call, key
> or fee belongs to current execution. The old tests and authorization state below are
> preserved as historical facts; current acceptance, push and deployment evidence belong
> to [the current report](video-v1-seeapi-verification.md).

Evidence date: 2026-10-04. This report extends the [original fixed-duration V1 record](video-v1-verification.md). The later user messages explicitly authorize multiple model families, native duration/resolution/audio controls, spoken-content moderation, competitor-style properties and profit/cost above 100%. They do not authorize publication, production changes or paid acceptance calls.

| Delivery layer             | Status                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Code implementation        | **IMPLEMENTED** for documented contracts and safety/funding gates; missing contracts and ambiguous tariff mappings remain unavailable |
| Local / Mock               | **PASS** for the checks below; concurrency-20 admission latency target **NOT_MET**                                                    |
| Real external services     | **BLOCKED / NOT_RUN**                                                                                                                 |
| Production feature opening | **NOT_DEPLOYED / DISABLED**; no production mutation or paid call                                                                      |

Working branch `main`, HEAD `569bf39eea9dcf072d3c5e5f79d58cd38d6bb466`. Existing dirty work remains in place, with no staging, commit, push, reset or deployment. Initial and follow-up snapshots are under `.cache/video-v1/`. See [actual implementation map](../implementation/video-v1-file-map.md), [original attribution](../implementation/video-v1-changed-files.md), [current delivery inventory](../implementation/video-v1-followup-files.md), [pricing and source evidence](../product/video-model-pricing.md), [configuration](video-v1-configuration.example.env) and [deployment/rollback](video-v1-rollout.md).

## Delivered behavior

- Family-grouped model picker and linked property panel, following the observed Raphael interaction: mode, ratio, duration, resolution and actual audio support. A changed property invalidates the quote; unsupported combinations cannot be submitted. Single image / one result remains the product boundary.
- Twelve documented model contracts implemented. Eleven have verified public tariff mappings; generic Veo is implemented but unquotable until its tariff identity is known. H3 Turbo/Max/Max Turbo and Veo Fast/Pro remain explicitly unavailable rather than aliases. Documentation is not evidence of account access or a successful output.
- Independent `VideoGenerationWorkflowV1`, stable request identities, immutable input fingerprints, durable callbacks, authoritative provider queries, transfer-only recovery and private reviewed playback remain in use. The old jobs-primary/global Outbox engine cannot process video business transitions.
- Full-cost prices bind every model parameter and policy snapshot. Default target is 110% profit/cost, with integer rounding, fees, moderation, runtime/storage and nonbillable failure allowance. Only paid lots with authoritative USD revenue evidence meeting the floor may fund new video requests. No formal production price is invented.
- Audio uses the same immutable private MP4, one AAC track, full-file streaming transcription and exact-transcript content moderation, with separate persisted phases. An uncertain paid transcription is not resubmitted. Final settlement/playback requires matching audio evidence in addition to visual evidence.

Audio acceptance is deliberately limited to spoken content in the supported languages; it is not certification of music rights or every ambient sound. The transcription input cap is 25,000,000 bytes. Empty/unintelligible speech, long unreviewed gaps or uncertain coverage fail closed. Output pixel checks use exact matrices only where officially documented (Kling 3); other models record actual dimensions and validate container, tracks, duration and known aspect ratio. Exact resolution certification for those models remains NOT_VERIFIED pending real samples.

## Repairs found through cross-review

| Finding                                                                                             | Repair and evidence                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Guest image requests and a stale Serializable image snapshot could bypass shared Kie capacity       | Shared provider-first lock and fresh post-lock capacity check. Real SQL regression: 3 failures before, all 4 cases pass after; 125 affected tests pass. `.cache/video-v1/cross-review-capacity-report.md` |
| Terminal/dead Workflow callbacks could starve a bounded inbox batch                                 | Terminal associations are ignored; failed notifications are delayed before replay. Database recovery regressions pass.                                                                                    |
| A visual-moderation send fence could be recorded before local preflight                             | Local retryable lease is separate from irreversible send intent; actual uncertainty still holds the attempt. Red-to-green regression evidence retained.                                                   |
| Small refunds with zero extra revoked credits could lower paid revenue without the account lock     | All three refund projections must serialize amount changes with the account used by video reservations. Final concurrent regression evidence recorded below.                                              |
| Image browser tests used stale Composer names; configured avatar bucket was rejected by image proxy | Scoped current accessible selectors; configured bucket allowlist and actual image-load assertion. Auth/avatar 2 pass; landing 25 pass, 1 existing skip.                                                   |
| Native Windows website packaging could not complete its Linux-oriented build                        | Disposable Linux source snapshot and native filesystem build, network guard and verified cleanup. Final source/artefact evidence recorded below.                                                          |

## Final verification matrix

| Check                                                     | Final evidence                                                                                                                                                                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dedicated video unit/Mock/runtime suite                   | **PASS: 31 files, 311 tests**, `node tests/video-v1/local-command.mjs test:video:unit`; `final-video-unit.log`                                                                                                            |
| Real isolated PostgreSQL video domain                     | **PASS: 6 files, 50 tests**, `test:video:database`; `final-video-database.log`                                                                                                                                            |
| Complete paid-funding Mock flow, real isolated PostgreSQL | **PASS: 6 scenarios, 353 unique jobs**; 353 provider Mock calls, 1,230 safety Mock calls, zero external paid calls                                                                                                        |
| All workspace types                                       | **PASS: 22/22 tasks, no cache**, `type-check`; `final-types.log`                                                                                                                                                          |
| Payment/refund regressions                                | **PASS: 99 tests in 6 files**; monetary-only races reproduced 3/3 failing before and 3/3 passing after; final fixture-cleanup recheck also 3/3 PASS                                                                       |
| Shared provider capacity regressions                      | **PASS: 125 affected tests**; four targeted cross-engine cases included                                                                                                                                                   |
| Audio HTTP adapter                                        | **PASS: 67 tests**, included in the 311 count; stream/backpressure/hash/size/timeout/coverage/policy/no-retry tests                                                                                                       |
| Actual local workerd audio and Workflow                   | **PASS: 6 tests**, included in the 311 count; three audio tests use actual global fetch into a separate local Worker, multipart parsing and independent SHA-256, complete ASR→text policy, upstream 503 and hash mismatch |
| Final video UI                                            | **PASS: 9/9 browser cases**, real local login with intercepted video RPC; 25 UI/render/locale tests also included in the 311 count                                                                                        |
| Affected image/account UI                                 | **PASS: auth/avatar 2, landing 25; 1 pre-existing skip**, one concentrated run                                                                                                                                            |
| Scoped source quality                                     | **PASS: 205 code paths lint with no warnings; 230 paths format check**, one test formatting issue fixed and rechecked                                                                                                     |
| Final Linux site and jobs artefacts                       | **PASS**: Next/OpenNext, Wrangler dry-run, final-bundle workerd; Jobs also passes local PostgreSQL tests                                                                                                                  |

Root final logs are in `.cache/video-v1/followup/`; individual review evidence is in `.cache/video-v1/*report.md`. Counts above overlap where explicitly stated; they are not summed into a fictitious unique total. Earlier fixed-duration batch checks (735 legacy integration cases, MinIO and broad API/SaaS unit checks) remain historical evidence in the original report, not reruns of the final multi-model snapshot. New payment, provider-capacity, audio, quote and UI paths received the focused regressions listed here. Hosted CI was **NOT_RUN**.

The final website build used a disposable Linux snapshot, compiled 59 pages and produced a Wrangler dry-run size of 34,598.47 KiB (gzip 8,186.36 KiB). Its final-bundle workerd checks cover health, login, theme and static caching. Website-bundle PostgreSQL smoke is **NOT_RUN**; the separate final Jobs bundle passed six concurrent local PostgreSQL reads plus native cross-Worker video binding checks. This does not claim production request latency or cloud database connectivity.

Final bundle SHA-256: website `9b16fd9fb994a53dc459459b854ad69fba4796831e3d77e8ddcc20bf235c255a`; Jobs `12890e679df7c71cd64f149558a901ea043abb824922fc5d29fc0e5248b14e7f`. Source snapshot/artefact manifests and cleanup are retained in `.cache/video-v1/linux-web-final/` and the workflow follow-up evidence. Documentation and a test-only formatting change after snapshot do not change the executable code represented by these builds.

The first final-flow attempt correctly hit shared-provider capacity because the reused disposable database retained five unrelated legacy fixture jobs. The fixture now records that baseline and adds only its tested concurrency to the test capacity; it does not delete those jobs or change the production cap. The subsequent complete 353-job run passed. A Windows shell argument-length limit interrupted the first quality-check invocation; checks were rerun in bounded file batches. Neither infrastructure failure was counted as a passing test.

[Browser evidence and screenshots](evidence/video-v1-followup/README.md) are clearly labelled fixtures. Their sample credit quote is not an approved production price. The private MP4 fixtures used for parser tests are synthetic containers, not successfully generated provider videos.

## Performance evidence

Admission optimization measured 20 concurrent requests over 10 runs: old in-transaction request-to-reservation marker P95 2,019 ms to 1,132 ms (44% lower); critical section P95 97 ms. This stress result still exceeds a 1-second target. The beta global cap remains 5, with no weakened reservation/isolation requirement.

The final flow evidence uses an application-observed timestamp after PostgreSQL COMMIT acknowledges admission. The earlier 2,019/1,132 comparison used an in-transaction write marker and must not be compared as an identical metric. Callback persistence also records COMMIT observation separately from receipt. Local Mock/provider timings never represent real generation, WAN, Hyperdrive or R2 performance.

Final paid-funding path measurements (milliseconds, P50 / P95):

| Concurrency | Request → reservation COMMIT observed | Callback COMMIT observed → confirmation | Request → READY   |
| ----------- | ------------------------------------- | --------------------------------------- | ----------------- |
| 5           | 88 / 167                              | 75 / 97                                 | 559.64 / 665.70   |
| 10          | 196 / 434                             | 157 / 243                               | 1096.61 / 1504.44 |
| 20          | 456 / 1265                            | 213 / 282                               | 1791.92 / 2375.39 |

Concurrency-20 lock wait P50/P95 is 381/1,135 ms; the sub-second stress target remains **NOT_MET**. Real provider/storage/moderation timings remain **NOT_RUN**, represented as null rather than invented measurements. The application's production beta concurrency cap is 5.

Evidence: [summary](evidence/video-v1/followup-performance-summary.json), [353 task stage records](evidence/video-v1/followup-task-stage-timings.csv), [independent CSV/percentile/hash validation](evidence/video-v1/followup-performance-validation.json). The source SHA-256 is `edde4ed2ae44180f668a4eb35650ffa4697d1741c20b88f4dd816a3f0f60abcb`; historical exports remain unchanged.

## External acceptance and production opening

- **NOT_RUN:** paid Kie generation, actual account tariff/region and model enablement, real native-audio/video moderation, provider callback signing/latency, production Hyperdrive/R2/Workflow recovery and real end-to-end stage latency.
- **BLOCKED:** exact missing model contracts and Veo tariff mapping; approved current full-cost prices and expiry; real provider/moderation credentials and account settings; authorized paid validation budget; external sample coverage, output host/CORS and production binding verification.
- **NOT_DEPLOYED / DISABLED:** no production database migration, Worker/site upload, callback registration, production setting update or whitelist opening. All three additive migrations were applied only to named disposable local databases.
- Rollback closes new admission while the original Workflow class, callbacks, private authorization, ledger and recovery continue to drain accepted jobs. Never reset uncertain attempts or route them through the legacy engine. Production deployment/rollback drills remain NOT_RUN.

## Resource cleanup

All recorded root test launchers/children, UI test trees and final build processes exited. Port 3349 no longer has the task's server. The Linux build container and disposable source snapshot were removed by the build runner; final artefacts remain available for inspection.

The identity-verified `ezpic-video-review-postgres-20261004` and `ezpic-video-review-minio-20261004` containers and their two anonymous volumes were stopped/removed after final validation; no matching containers or volumes remain. This also discards all local synthetic accounts, payments and media fixtures. Evidence: `.cache/video-v1/followup/final-process-audit.json` and `resource-cleanup-final.json`. The shared `supastarter-postgres` and `supastarter-minio` are still running and were not modified by cleanup. No task-owned service is intentionally retained.
