# Video model contract evidence — 2026-10-04

Source: official `https://docs.kie.ai/llms.txt` index and the linked public Markdown OpenAPI documents, downloaded read-only. No account credential or paid generation was used. Checked request schemas and SHA-256 hashes are preserved in `packages/ai/media/catalog/fixtures/kie-video-model-contracts-2026-10-04.json`. These document snapshots establish an API contract, not live account access or successful generation.

| Public model            | Implemented generation parameters                                                                                           | Actual audio control                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| MiniMax H3              | Text / one first frame; 4–15 integer seconds; 768p / 2k; six text ratios; source ratio for image                            | No API mute switch; permit and moderate provider audio |
| Seedance 2.5            | Text / one first frame; 4–30 integer seconds; 480p / 720p / 1080p; six ratios plus image adaptive                           | `generate_audio`                                       |
| Seedance 2              | Text / one first frame; 4–15 integer seconds; 480p / 720p / 1080p / 4k; six ratios plus image adaptive                      | `generate_audio`                                       |
| Seedance 2 Mini / Fast  | Text / one first frame; 4–15 integer seconds; 480p / 720p; six ratios plus image adaptive                                   | `generate_audio`                                       |
| Seedance 1.5 Pro        | Text / one first frame; 4–12 integer seconds; 480p / 720p / 1080p; six ratios                                               | `generate_audio`                                       |
| Seedance 1 Pro Fast     | One image only; 5 / 10 seconds; 720p / 1080p; source ratio                                                                  | No audio feature; silent output required               |
| Gemini Omni 1.1 Flash   | Text / one first frame; 4 / 6 / 8 / 10 seconds; 360p / 720p / 1080p / 4k; 16:9 / 9:16                                       | No API mute switch; permit and moderate provider audio |
| Kling 3                 | Text / one first frame; 3–15 integer seconds; std=720p / pro=1080p / 4K=2160 short side; 16:9 / 9:16 / 1:1 and image source | `sound`                                                |
| Kling 3 Turbo           | Text / one image; 3–15 integer seconds; 720p / 1080p; three text ratios and image source                                    | No API mute switch; permit and moderate provider audio |
| Kling 2.6               | Text / one image; 5 / 10 seconds; provider default resolution; three text ratios and image source                           | `sound`                                                |
| Veo 3.1 new unified API | Text / one first frame; 4 / 6 / 8 seconds; 720p / 1080p / 4k; 16:9 / 9:16 and image Auto                                    | Background audio by default; upstream may omit it      |

The six ratios are 16:9, 9:16, 1:1, 4:3, 3:4, 21:9. Fixed durations are required for immutable quoting; automatic `-1` duration is deliberately excluded. Multi-image, last-frame transitions, reference video/audio, multi-shot, web search, enhancement, and editing are outside the authorized text/single-image workflow. All Seedance calls enable the documented `nsfw_checker`; this does not replace application moderation. Veo prompt translation is explicitly disabled so the submitted prompt remains the moderated prompt.

The UI uses the catalog's valid capability groups. A missing supplier audio switch is never represented as a working mute toggle. `sound: true` on provider-native models permits an audio track and requires audio safety coverage; it does not promise that every provider output includes audio. There is no client-selectable provider ID, URL, price or retry policy.

## Document limitations and launch gates

- **BLOCKED:** MiniMax H3 Turbo, H3 Max Turbo and H3 Max have no matching official Kie model contract in the fetched index. They remain visible as unavailable catalog entries, never aliases to H3.
- **BLOCKED:** Veo 3.1 Fast and Pro exact mappings. The new official document uses `/api/v1/jobs/createTask`, `model: veo-3-1`, but still mentions older `veo3_fast`/`veo3_lite` names in prose and an older callback shape. Do not guess a variant or assign a quality-tier cost to the new generic model. The generic request builder is implemented, but admission requires independently verified pricing and contract readiness. Old Veo routes and automatic fallback are not implemented.
- **BLOCKED for exact-pixel certification:** MiniMax H3 documentation only specifies `768P` / `2K` labels; it does not define whether `2K` means a 1440 or 2048 pixel short side. Do not fabricate exact pixel evidence.
- Kling 3 generated `required[]` lists `multi_prompt` and `aspect_ratio` universally, while its prose and examples make them conditional: `multi_prompt` applies only to multi-shot, and the aspect is optional with images. The implementation follows the documented single-shot example and conditional descriptions, with a contract regression test recording the discrepancy.
- Kling 3 and generic Veo use a conservative application prompt cap of 1,000 Unicode code points where the fetched API document does not specify a single-shot prompt maximum; this is an application limit, not a claimed provider limit.
- All models additionally have an application ceiling of 10,000 UTF-16 code units, matching the configured text-moderation API limit. The catalog displays the lower of its provider/app code-point bound and 10,000, and input validation separately enforces the UTF-16 ceiling. Larger official provider limits (for example Seedance 2.5's 30,000) remain in the source fixture; they cannot admit text that our safety adapter cannot review.
- API documentation availability does not prove credentials, enabled models, price completeness, output-host coverage, valid moderation account settings, or production readiness. Each enabled model/parameter price still needs the server pricing gate and authorized external acceptance.

## Focused local verification

- `pnpm --filter @repo/config exec vitest run video-models.test.ts`: **PASS**, 6 tests; traverses every implemented mode and every generated legal tuple, checks mode/assets, unsupported variants, audio, Unicode bounds and the real text-moderation length ceiling.
- `pnpm --filter @repo/ai exec vitest run media/providers/kie-video-models.test.ts`: **PASS**, 21 tests; compares mappings/properties/enums to saved official schemas, verifies immutable single input mapping, real audio fields, no transformation/fallback, authoritative query, and one paid-submit attempt on HTTP 408/429/500/503.
- `pnpm --filter @repo/config type-check` and `pnpm --filter @repo/ai type-check`: **PASS**.
- Focused Oxfmt / Oxlint: **PASS**.
- Real external generation and account/model enablement: **NOT_RUN / BLOCKED** pending explicit paid-service authorization and required configuration.
