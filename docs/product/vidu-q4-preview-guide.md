# Vidu Q4 Preview editorial guide

Reviewed on 2026-10-11. Canonical: `/blog/vidu-q4-preview`.

This article explains Vidu's official model and sends Q4 trials to Vidu. EzImageAI's current
`packages/config/video-models.ts` catalog has no Vidu/Q4 entry. The separate `/create?mode=video`
link is explicitly labelled as other EzImageAI models. No provider integration, pricing change,
paid generation, fabricated sample or deployment is included.

## Evidence and limits

- The official [release notice](https://platform.vidu.com/docs/api-reference/updates) records
  2026-10-07. The keyword card's 10/8 date is a discovery signal, not the release date or demand size.
- [Image-to-video](https://platform.vidu.com/docs/api-reference/video-models/vidu-q4-preview/image-to-video)
  and [reference-to-video](https://platform.vidu.com/docs/api-reference/video-models/vidu-q4-preview/reference-to-video)
  document `viduq4-preview`, 3–16 whole seconds, output up to 4K and optional generated sound.
  Reference input accepts 1–15 images and 0–3 MP3 files of 3–12 seconds each.
- The [consumer Q4 page](https://www.vidu.com/vidu-q4) FAQ lists 1–16 seconds for reference mode,
  conflicting with the API. The article explicitly states the distinction and follows API limits
  for integration planning. Output resolution is not represented as native generation resolution.
- [API pricing](https://platform.vidu.com/docs/overview/pricing) lists 9/19/24/38/78 Vidu credits per
  second at 540p/720p/1080p/2K/4K. Its packages are RMB-denominated. Article examples are simple
  arithmetic, not paid tests, EzImageAI quotes or a universal USD price.
- Q3 has a separately documented [text-to-video endpoint](https://platform.vidu.com/docs/api-reference/video-models/vidu-q3/text-to-video).
  Q4 is not described as replacing every Q3 workflow.
- API type/authentication examples disagree. No untested runnable API code is supplied. Speed,
  cost and performance improvements remain manufacturer claims, without independent benchmarks.

## Publication and release

The existing Blog reader, static parameters, metadata and sitemap own the page. English is the
only authored language; `?lang=de|es|fr` fallback remains noindex with the English canonical and
no manufactured hreflang. No Offer, Review or FAQ structured data is added. The three prompt
suggestions are original and clearly untested; no Q4 media samples are shown.

Baseline: remote main `58d020b215f071ddb5e8464024bbe1372cc37a48`, observed on 2026-10-11. The initial
local main `52533d26396610df0575edb166ea2d09158841b6` was older; this guide branch was rebased to the
remote baseline, preserving Kie rejection recovery, shared-credit fixes and Blog ad isolation.
Ordinary video uses the shared account balance including valid gifted credits; separate templates
retain their own funding rules. This branch is prepared for parent review;
the parent must coordinate the advertised concurrent release window. Do not deploy this branch
independently. New Q4 provider credentials, costs and paid acceptance tests need a separate task.

## Verification

Validated on 2026-10-11 against the rebased branch:

- SaaS type checking and Next.js production build passed. Build output is recorded in
  `.cache/vidu-q4/build.log`. Inherited named JSON export, Hono dependency and placeholder OAuth
  configuration warnings remain; there were no build errors.
- Twelve focused Vitest files passed all 129 tests, including public routes, sitemap, Markdown
  links and the existing Blog ad tests. The accompanying nine Cloudflare build-policy and guard
  tests passed. Formatting, lint and `git diff --check` passed for the affected files.
- The focused public Playwright test passed against the production bundle at 1440px and 390px.
  It checked server-rendered content, metadata, official and EzImageAI link destinations, copyable
  prompts, Blog discovery, fallback indexing and horizontal overflow. The existing public image
  catalog fixture isolated the local database dependency; generation, payments and live provider
  requests were not tested. Report: `output/vidu-q4/report.json`; screenshots: the `vidu-q4-1440.png`
  and `vidu-q4-390.png` files under `output/vidu-q4/results/`.
- Independent source/content and code reviews passed after the rebase. The code review confirmed
  that existing Blog advertising behavior and release fixes were retained.

This is focused change validation, not a full CI or Cloudflare adapter packaging result. Parent
release coordination, any remaining release checks and deployment are still required.
