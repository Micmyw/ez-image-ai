# Seedance Mini migration — 2026-10-20

New Hotel Lobby duo and Raindance solo/duo orders use Seedance 2 Mini after the coordinated release. The merchant retirement notice supplied for this change says Seedance 1.5 Pro stops accepting new tasks at 2026-10-21 12:00 Asia/Shanghai. No real paid generation or payment was authorized for this migration.

## New and frozen contracts

- New five- and ten-second templates use schema 4 and `video-seedance-2-mini`. Their template versions are `hotel-lobby-duo-mini-2026-10-20.1`, `raindance-mini-2026-10-20.1`, and the corresponding `-mini-10s-2026-10-20.1` versions. The new retail version is `video-effect-mini-retail-2026-10-20.1`; the Hotel Lobby cost version is `hotel-lobby-duo-mini-cost-2026-10-20.1`.
- The scene remains one reviewed Nano Banana Lite image. Its private URL becomes `first_frame_url`; no reference image/video/audio arrays are mixed into the Mini request. This product has one frame input, so it does not add a last-frame upload flow.
- Mini supports 480p/720p and 4–15 seconds. Templates retain 720p, portrait 9:16 and explicit `generate_audio:false`. They do not send `fixed_lens`; steady framing is a prompt request, not a guaranteed camera-control capability. Motion prompts receive new versions.
- Ordinary new orders reject Seedance 1.5 Pro and hide it from current choices. An old, unsubmitted 1080p draft keeps its original fields and asks the user to select a current model; it is never silently converted to Mini 720p. The ordinary default remains its existing model.
- Legacy schema 1/3 snapshots, old model keys and full old capability rows remain readable. The old key still resolves to `bytedance/seedance-1.5-pro`. Accepted requests replay their original job/reservation before new-admission checks; accepted attempts keep querying their original provider task. No automatic replacement, refund, second charge or repeat submission is introduced.
- Rumpelstiltskin keeps schema 2 and its existing Seedance 2 reference-video contract. The global model and Veo tier contract versions remain unchanged.

## Complete template quotes

[Official Mini parameters](https://docs.kie.ai/market/bytedance/seedance-2-mini) distinguish first/last frames from reference arrays. [Official pricing](https://kie.ai/seedance-2-0-mini) lists 720p without reference video at $0.041/second: $0.205 for five seconds and $0.410 for ten. The discounted reference-video tariff is not used for this first-frame product. The old 1.5 Pro video portions were $0.0875/$0.175.

The existing template calculation retains the $0.020 scene, image/text/video review budgets, runtime/storage allowances, 10% nonbillable-failure reserve and 7.5% payment-fee allowance. Its markup inputs remain 20,000 bps for five seconds and 27,500/23,750 bps for standard/annual ten seconds. Annual membership still halves only the surcharge above the approved template base.

| Duration   | Video supplier portion | Direct budget | Risk-adjusted budget | Standard credits | Annual credits |
| ---------- | ---------------------- | ------------- | -------------------- | ---------------- | -------------- |
| 5 seconds  | $0.205                 | $0.466400     | $0.518223            | 92               | 92             |
| 10 seconds | $0.410                 | $0.672400     | $0.747112            | 178              | 154            |

These are reference budgets using the unchanged historical 21,944 USD-micros/credit conversion. Shared account credits, including gifts and discounted purchases, are equally usable; they do not certify actual payment revenue or realized profit. Expiry, refunds, debt, ownership, atomic reservations/returns, idempotency and content safety remain enforced. Image passes remain a separate explicit unit.

## Release and verification

1. Complete the independent shared-credit and annual-price releases first. Recheck the exact migration head's full CI, including real PostgreSQL integration and browser/gzip gates. Local mocks do not prove live supplier access or video fidelity.
2. Read fresh unfinished legacy counts immediately before cutover. The earlier read-only inventory at 07:02 UTC had two completed ordinary legacy jobs and zero unfinished legacy jobs; that observation is not a reason to remove old consumers. New legacy tasks may arrive before cutover.
3. Keep `VIDEO_V1_BUILD_MODEL_VERSION=video-models-2026-10-08.1`, ordinary price/catalog overrides, access, callbacks and safety budgets unchanged. Set only `VIDEO_EFFECT_BUILD_RETAIL_PRICE_VERSION=video-effect-mini-retail-2026-10-20.1` on both build triggers. The validated in-process overlay upgrades recognized old short/long template approvals and the Hotel Lobby price version, appending this source to the existing price basis without exporting the protected pack or credentials. Unknown bases fail closed.
4. Deploy compatible Jobs consumers before website producers. New schema 4 continues checking both scene-model emergency switches inside the final admission transaction. Frozen legacy scene preparations and provider retrieval remain compatible with new admission approvals.
5. Verify both active Worker tags, safe complete-cost preflight for all six effect/duration combinations, public new choices and credit quotes. Do not claim real payment, model acceptance, visual quality or fixed-camera fidelity from mock/contract/database tests.

Before the provider deadline, an admitted legacy task that has not reached its first supplier POST retains its original model and contract. After the deadline it must not be silently redirected: a definite provider rejection follows the existing failure/return path, while uncertain acceptance remains reserved and held for the original task's recovery. Production task mutations or real paid validation require a separate concrete decision.

After any schema 4 order is accepted, retain Mini-compatible Jobs receivers and website history readers. Pause new template admission or fix forward if necessary; returning to a parser that only understands schemas 1/2/3 would strand accepted orders. A billing catalog or selector rollback must retain these compatible consumers. Do not reopen the retired 1.5 Pro key after its supplier deadline.
