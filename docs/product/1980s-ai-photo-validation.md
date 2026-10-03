# 1980s photo effect: content and acceptance record

This round completes the first content-bearing effect while preserving the existing content reader,
draft isolation, shared editor, authorization, moderation, quote, job and credit flows. It does not
authorize or record a Git push or production content deployment.

## Why the original directory was empty

The only authored record was `draft`, with no cover, examples or preset tests. The published reader
correctly excluded it. Its initial zero-item directory was noindex and its public detail was 404.
No validation rule was removed to change that state.

## Material and actual generation evidence

The user authorized the built-in image tool for material, then explicitly authorized at most six
EzImageAI generations / 30 credits, stopping if the 5-credit quote changed. The input is one
fictional adult woman created without a real-person reference. It is identified as AI-generated;
it is not claimed to be a historical photograph or an EzImageAI-generated source.

All four product calls used the existing signed-in production homepage editor at `https://ezimageai.com/`,
the same original WebP and Nano Banana 2 Lite at 1K. No provider was called directly. Each task
reached Ready and its UI reported 5 credits charged, 0 returned. Available credits moved from
1000 to 980. The rejected editorial candidate still cost 5 credits. No additional generation is
required or scheduled; the unused authorization is 2 calls / 10 credits.
The tested prompts and settings match the new effect record. The new effect route itself has not
been deployed: its editor integration was checked locally without submitting further generations.

| Attempt | Preset    | Requested ratio | Editorial result                                                                                                      |
| ------- | --------- | --------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1       | Studio v2 | 4:5             | Accepted: feathered hair, denim and blue-gray backdrop; subtle face/crop changes remain.                              |
| 2       | Family v2 | 4:3             | Rejected: obvious red-eye, open smile and print-damage flecks. Retained internally.                                   |
| 3       | Street v2 | 4:5             | Accepted: warm city scene and denim; smile and background scenery changed.                                            |
| 4       | Family v3 | 4:3             | Accepted: no obvious red-eye and a closed mouth in this run; generated album frame and background decorations remain. |

The family revision changed several instructions together. It does not isolate a causal fix or
establish a general face-preservation guarantee. Hands, groups and full-body inputs were not tested.
These are three example configurations on one input, not a success-rate study. The output files
were only resized/encoded for web delivery; no creative retouching was applied.

- Durable internal record: [input, four attempts, credit observations, reviews and hashes](./evidence/1980s-ai-photo-2026-09-29.json).
- Original generation and downloaded masters: `output/1980s-content-validation/`.
- Public marketing files: `apps/saas/public/images/effects/1980s-ai-photo/` (one source, three approved outputs).
- Exact prompt/version/model/parameter snapshots are stored in the server-only effect record.
  Public readers remove internal job references, rights evidence and test provenance.
- The earlier family v2 image is excluded from the public marketing directory and content record.

## Page and content changes

The locally published effect supplies the homepage recommendation, the one-theme Effects directory,
three preset cards, original/generated comparisons, the existing same-page editor, real model/date/
parameter captions, instructions and observed limitations. Full prompt text is present in server
HTML even when its disclosure is closed. Copy and use-preset resolve the same authored text.

The old prompt article retains `/blog/ai-image-editing-prompts`, its title, body and original dates.
It now derives a visual comparison and precise studio-preset CTA from reviewed published content.
The privacy article retains its address and does not receive an unrelated portrait. No separate
face-consistency tutorial or duplicate 1980s article was published.

Docs keeps the existing five topics and namespaced search/Markdown/OG endpoints. Its navigation,
colors and spacing now match the product, and its text covers actual user actions, credits, privacy
and recovery rather than infrastructure setup.

## Engineering and visual verification

Verification completed on 2026-09-30 (Asia/Shanghai). Checks ran sequentially around the shared
Fumadocs generated source. The following results are separate runs, not an additive test total.

| Check                                                                                     | Observed result                                                                                                                                                                                                                       | Evidence below `output/1980s-content-validation/`                                                                   |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Content, preset selection, public routes, Blog, Docs and existing editor unit group       | 17 suites passed; the remaining Blog suite initially contained a stale assumption that 1980s was always draft. It was replaced by a published relationship check plus an independent draft fixture, and its focused rerun passed 7/7. | `unit-check.log`, `blog-content-rerun.log`                                                                          |
| Existing result-panel compatibility                                                       | 16/16 passed after a minimal type-narrowing compatibility fix for concurrent shared-preview work.                                                                                                                                     | `preview-compatibility-check.log`                                                                                   |
| Login/draft return and cookie isolation                                                   | 14/14 passed in two existing focused suites. Preset application also retains the owned reference and protects changed prompt/settings in the unit group above.                                                                        | `draft-recovery-check.log`                                                                                          |
| Production Next build                                                                     | Passed, including TypeScript and 55/55 static pages, after the final MDX repair. Existing Hono dynamic-dependency and unconfigured local OAuth-provider warnings remain.                                                              | `build-docs-verified.log`                                                                                           |
| Public content and Docs browser acceptance                                                | 19/19 passed, no skips or flaky tests: real asset bytes, complete anonymous HTML, copy/preset equality, same-page preparation, mobile menu, 360px overflow, desktop/mobile screenshots, old Blog URLs, Docs routes and endpoints.     | `browser-verified.log`, `final-browser/browser-report.json`                                                         |
| Final Docs regression after invalid nested paragraphs were found during manual inspection | 9/9 passed, including raw server-HTML validation for both affected pages, typography, navigation, gallery CSS isolation, search and namespaced endpoints.                                                                             | `docs-browser-verified.log`, `docs-browser/browser-report.json`                                                     |
| Format, lint and whitespace                                                               | Oxfmt passed for 88 affected/module files, scoped Oxlint passed, and `git diff --check` passed. The subsequent two MDX repairs and their regression assertion were also formatted.                                                    | `checked-files.json`, `format-check.log`, `lint-check.log`, `diff-check.log`                                        |
| Manual Docs interactions                                                                  | At 390px, navigation opened and followed Quick start; search for `credits` returned results and opened `/docs/credits`. Fresh visits to both repaired MDX pages produced no new browser errors.                                       | `docs-mobile-navigation.png`, `docs-search-390.png`, `docs-hydration-browser.json`, `mdx-paragraph-regression.json` |

The first browser run found the Effects mobile menu entry inside a closed tools disclosure.
Effects now appears alongside Blog and Docs in the drawer, with no duplicate hidden entry. Older
Docs checks were updated to use the current gallery markup and wait for font styles. Manual
inspection also caught `<p>` inside `<p>` in the two prompt examples; these now use normal MDX
paragraphs, and the raw-HTML regression check prevents the browser's automatic repair hiding it.

The production browser checks used the existing local `ezpic` database, with generation and
billing disabled. Its read-only catalog/capability requests returned 200. A prior run pointed to
the wrong local database and is retained as historical output; it is not availability evidence.
No local browser check submitted a quote, generation, purchase or payment. These checks are not
counted as real product calls; only the four production jobs above establish generation evidence.

### Actual page screenshots

The selected originals are copied without alteration into
[`output/1980s-content-validation/screenshots/`](../../output/1980s-content-validation/screenshots/).
They show the normal anonymous content routes with approved images, not administrator previews.

- [Effects directory, desktop](../../output/1980s-content-validation/screenshots/1980s-directory-desktop.png)
  and [390px first fold](../../output/1980s-content-validation/screenshots/1980s-directory-390-firstfold.png).
- [1980s detail, desktop with all three preset cards](../../output/1980s-content-validation/screenshots/1980s-detail-desktop.png),
  [390px first fold](../../output/1980s-content-validation/screenshots/1980s-detail-390-firstfold.png)
  and [360px with full prompts expanded](../../output/1980s-content-validation/screenshots/1980s-detail-360.png).
- [Three actual preset outputs in the shared development preview](../../output/1980s-content-validation/screenshots/1980s-three-presets-desktop.png)
  and [the family card switched back to its original](../../output/1980s-content-validation/screenshots/1980s-family-original-toggle.png).
  These two captures include the development error badge from the shared preview's catalog issue below.
- [Blog directory with original/result comparison](../../output/1980s-content-validation/screenshots/1980s-blog-directory-desktop.png)
  and [article's exact prompt and targeted CTA](../../output/1980s-content-validation/screenshots/1980s-blog-preset-desktop.png).
- [Docs desktop](../../output/1980s-content-validation/screenshots/docs-desktop.png)
  and [repaired Quick start at 390px](../../output/1980s-content-validation/screenshots/docs-quick-start-390.png).

The 3196 acceptance preview intentionally disables generation, so the detail screenshots show
the editor's real unavailable-state message while retaining prompt copying and preset selection.
They do not claim that the local test environment can generate. The real output evidence is stored
separately with the four Ready screenshots, original output files and internal job references.

### Local publication checks

- The directory and canonical detail return anonymous 200 with one H1, English content and
  index/follow; all complete prompts, captions and model/date details are in server HTML.
- Both routes enter the sitemap. Preview and unknown effect routes return anonymous 404 and
  are absent from the sitemap. Independent draft fixtures remain excluded from public DTOs,
  Blog relationships and recommendations.
- A final HTML check of `/effects`, the detail, Blog index, the old prompt article and Docs returned
  200 with one H1 each and no match for the four internal job IDs, evidence path, rights verification
  marker or signed URL signature marker: `local-publication-check.json`.
- Preset and source/UTM parameters preserve one clean canonical while restoring the selected
  preset. The homepage H1 remains `AI Image Editor No Restrictions`; its metadata source was
  not edited for this content round.
- The homepage, directory, three preset shortcuts and old Blog article form traversable links.
  Copying, navigation and selecting presets made no business mutation requests in acceptance.
- Four public WebP files contain one fictional input and three approved outputs. Private
  evidence, rejected output, internal job IDs and signed media URLs are not public content fields.

### Review preview and process cleanup

The existing shared preview remains available at `http://127.0.0.1:3002/effects`,
`/effects/1980s-ai-photo`, `/blog` and `/docs`. The Docs source was regenerated for Next after
Vitest had written its Vite-specific source; the shared server did not need to be stopped.
That shared preview still reports a 500 from its model-catalog RPC and the editor correctly shows
generation unavailable. Its launch configuration was not changed. This limits interactive local
generation in that preview, not the approved image/prompt content; the isolated production-bundle
acceptance used the existing local `ezpic` database and returned 200 for that read-only RPC.
An attempted separate persistent preview was rejected by automatic approval review without a
specific reason. It was not retried; the existing preview was recovered instead.

Task build/browser commands exited and the temporary 3196 server closed. No new persistent
process is retained. The existing 3002 server and shared PostgreSQL were not stopped. Browser
viewport overrides are reset at handoff; the production test tab is closed after its evidence
has been saved. No credentials or environment files were changed.

## Publication boundary

The `published` content record is local. Production Effects/Blog/Docs deployment, anonymous live
200/canonical/sitemap checks, CDN/WAF crawler reachability, real OpenAI crawler logs, indexing,
ranking and organic referral observations remain outside this authorized local release. No WAF
or crawler security setting was changed. A local User-Agent check cannot prove actual crawler access.
