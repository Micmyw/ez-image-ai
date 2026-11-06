# Hotel Lobby and Flying Car source contract audit

Read-only source investigation: 2026-11-06. Source HEAD is `75c06e3b5f8141ac45a3bd37fe494b44cc8f7769`. Hotel/Flying core files match that fixed commit; unrelated source working-tree Rap/category edits were preserved. Imported Flying prompt/helper files were read from Git objects.

## Hotel Lobby

The source intentionally submits no prompt, model override or duration. `src/core/ai/seeapi-video.ts:59–69` builds `provider: seeapi` with exactly two ordered `input.reference_images`, `input.aspect_ratio` and `input.resolution`, plus optional callback. Lines 170–180 choose `POST /v1/templates/hotel-lobby-ai/generations`; lines 184–199 retrieve the same task using `GET /v1/generations/{id}`. `src/lib/hotel-lobby.ts:3–36` defines two native resolutions and seven aspect ratios.

This is an implemented source business path: `src/modules/ai-tasks/rap-video.ts:613–614` explicitly stores an empty internal task prompt for hosted templates. Lines 753–757 skip only customer-text review because no customer text exists, after both images were owner-checked and approved. Lines 566–578 enforce both portrait approvals and source dimensions. Public history intentionally uses `duration: null` at line 368; the lifecycle regression asserts null at `rap-video.test.ts:725–730` and no `input.prompt` at lines 785–799.

Target representation: a provider-owned template discriminator and nullable prompt/duration, the same hosted endpoint, ordered private portrait bindings, and unchanged source output choices. Do not supply a substitute prompt or assume the preview's length is the API output contract. Target output inspection validates measured media under a bounded hosted-template policy, while retaining normal image and final-output review.

Source retail pricing is `hotel_lobby_768p_credits` / `hotel_lobby_2k_credits`, with defaults 10 / 20 source-site credits (`src/lib/hotel-lobby.ts:14,47–64`). Admission compares the current selected source price before debit (`rap-video.ts:520–536`). The selected integration archive does not include these two keys; absence from that archive is not evidence that production has no override. Target credit units remain independently configured.

The [official Hotel Lobby API page](https://www.seeapi.com/docs/templates/hotel-lobby-ai/) corroborates the hosted request and optional callback/polling route. Its displayed supplier price on the audit date was 285 credits per 768P generation and 395 per 2K generation. Supplier credits are distinct from source or target retail credits. A documented quote endpoint can estimate without generating; this audit made no authenticated quote or generation calls.

## Flying Car

`src/modules/ai-tasks/video-prompt.ts:3–20` selects four complete original raw prompts:

| Source template      | Prompt file                  | Frozen version              | Duration | Fixed references after user subject |
| -------------------- | ---------------------------- | --------------------------- | -------- | ----------------------------------- |
| curved-ramp-showcase | flyingcar-curved-ramp-v5.txt | flyingcar-h3-curved-ramp-v5 | 15 s     | Six numbered JPGs, one WAV          |
| curved-ramp          | flyingcar-curved-ramp-v6.txt | flyingcar-h3-curved-ramp-v6 | 15 s     | Same six numbered JPGs, one WAV     |
| fleet-side           | flyingcar-fleet-side-v1.txt  | flyingcar-h3-v1             | 7 s      | Five numbered JPGs, one WAV         |
| fleet-front          | flyingcar-fleet-front-v1.txt | flyingcar-h3-v1             | 7 s      | Five numbered JPGs, one WAV         |

`src/lib/video-templates.ts:2–57` freezes durations, 16:9 framing and reference counts. `video-prompt.ts:39–74` uses `flyingcar_h3_asset_base_url` when provided; otherwise it uses the source app origin and versioned reference root. It generates ascending `reference-01.jpg` through the template count and then `audio.wav`; public previews are never model inputs.

`src/modules/ai-tasks/video.ts:395–405` freezes the approved user image first, all ordered fixed frames, and one source audio reference. Lines 438–452 submit those fields. `src/core/ai/kie.ts:339–386` accepts the exact 7-image/15-second or 6-image/7-second 16:9 contracts, native 768P/2K, and no video/first-frame modality. Lines 389–406 send `model: minimax-h3/reference-to-video` to Kie's original createTask route. No scene regeneration or model replacement is needed.

Source retail uses resolution-scoped Flying Car package units, not Rap credits. Curved ramp costs two units and fleets one (`video-templates.ts`). `src/config/pricing.ts:44–74` defines one-time packages: 768P 1/3/6 fifteen-second equivalents for USD 4.99/12.99/19.99; 2K 1/3/5 for USD 9.90/19.90/29.90. Those balances and units are not imported into the target shared-credit account.

The [Kie H3 model page](https://kie.ai/minimax-h3) observed on the audit date lists USD 0.04 per output second at 768P and 0.065 at 2K, with the first five images included, USD 0.02 per additional image and audio input free. These Flying reference counts add two image charges for curved ramp and one for fleets: generation-only listed bases are USD 0.64 / 1.015 for 15 seconds and 0.30 / 0.475 for 7 seconds (768P / 2K). This excludes review, storage, transfer, failures and account discounts; it is not target price approval.

## Evidence limits

Source prompt bytes, reference order, parameters and mock transports are verified locally. No real generation was requested. Existing source samples demonstrate their stated provenance only; no target generation quality timestamp or successful paid integration is asserted.
