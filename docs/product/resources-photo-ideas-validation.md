# Resources and Photo Ideas: local acceptance

Date: 2026-10-04. Plan: [Resources and interactive Photo Ideas](../plans/2026-10-04-resources-photo-ideas.md). Product rules: [Resources and Photo Ideas](./resources-and-photo-ideas.md).

Implementation is in `codex/resources-photo-ideas`, based on `1b3c9dc2c2b5ee3e9dd0b05e3fea02141908d04b`, in the Codex-managed `resources-photo-ideas` worktree. Release integration includes remote main through `01f4314c6bab7d9a9c08d178d04d538dd44c33de`. The shared checkout and its existing work are preserved. This report records local implementation and verification before publication. [PR #15](https://github.com/Micmyw/ez-image-ai/pull/15) records Git publication and remote CI; deployment is separate.

## Delivered behavior

- The header, mobile drawer, editor navigation, Docs and footer use AI Image, AI Tools, AI Models, Resources and Pricing. Resources contains Blog, Editing Examples and Docs.
- Blog owns the 1980s article at `/blog/1980s-ai-photo`, including publication, dates, category, discovery and metadata. Photo Ideas is a Blog category; there is no separate public Effects catalog.
- The article retains three complete preset prompts, genuine reviewed outputs and original comparisons, limitations, and the existing same-page editor. Existing unrelated Blog URLs remain unchanged.
- Legacy `/effects` redirects permanently to `/blog?category=photo-ideas`. The registered legacy detail redirects with HTTP 308, retaining validated preset, source and language context. Unknown and unpublished identities remain inaccessible.
- Publication requires both a published article and a validated published recipe. Navigation, recommendations, callouts and sitemaps use the published Blog reader.
- Existing legacy saved drafts and short-lived claimed-draft cookies can return to the canonical Blog article. Authentication, ownership, path isolation and parameter validation remain in force.

## Engineering verification

- Affected SaaS unit coverage includes content and evidence validation, draft filtering, routes, metadata, sitemaps, navigation, editor preset selection, guest/login/upgrade recovery, and homepage hierarchy. Initial failures in renamed markers, metadata shape and updated Docs dates were corrected and rerun.
- Final focused routing, proxy and navigation rerun: **42/42 passed in six files**, including the newly deferred account-wrapper SSR branches.
- API claimed-draft return/cookie tests: **12/12 passed**.
- SaaS, API and shared-config type checks passed. The final production build also runs TypeScript.
- Affected production-build browser run: **34 functional cases passed**, with no skips. Its sole failure was the existing homepage resource budget; after removing unused retired-directory translations, a fresh production build and the focused budget case passed. All **35 affected cases** therefore have a passing result, across the functional run and final performance rerun.
- Formatting passed for all **98 affected files**; focused lint passed for **74 source files**; `git diff --check` passed. Generated local evidence/cache files are excluded from source checks.

At the original acceptance, `LandingGenerator`, `GenerationForm`, `ImageEditorWorkspace`, generation styles, the recipe record, public example assets and durable generation-evidence JSON had no changes against the starting commit. Release integration retained the coloring-preview changes from `3b781797` and compact composer from `01f4314c`. `LandingGenerator`, `GenerationForm`, `ImageEditorWorkspace`, `ImageOutputSettings` and `generation-composer.css` are identical to that current remote main. The original 1980s recipe, asset bytes and generation-evidence JSON are also unchanged. Existing composer labels, source/prompt ordering and output-setting popovers are tested as implemented upstream; no production form was changed to satisfy stale selectors.

Final release integration verification:

- The full SaaS run after incorporating `01f4314c` passed **800 cases**, with one unchanged Docs source import exceeding its 5-second timeout under parallel load. The immediate focused rerun passed **all five Docs source cases**, without changing its code or timeout. The previous integration run passed **799/799** cases.
- A fresh production build and browser run passed **86/86 cases**, with **zero skipped, failed or flaky cases**. This includes all three administrator preview cases, published/legacy routes, preset replacement safeguards, original/output evidence, Resources navigation, homepage and image-to-image, including 320px layouts.
- The authenticated mobile keyboard regression now exercises the current settings popover, real Tab/Space/Escape interaction, High-to-2K SKU linkage and 15-credit display. Its integrated storage/database execution is a remote CI gate; the public browser fixture is not evidence for that authenticated flow.
- Formatting and lint passed for the four updated browser test files; the final production build passed TypeScript. The homepage resource limits remain unchanged and passed with the measurements below.

The local browser environment uses an isolated `ezpic_effects_e2e_resources_test` database on loopback. Existing migrations initialized it; no schema change was added. Generation and billing remain disabled, and interactive generation controls use local browser fixtures without submitting generation or payment requests. Temporary administrator accounts are created and removed by the existing guarded fixture. The local build uses a nonfunctional placeholder mail key; no mail is sent.

## Actual page screenshots

The refreshed release captures are produced by the public browser suites under `apps/saas/.cache/resources-photo-ideas-release-current-main/`. These are local rendered-page evidence, not production-deployment evidence.

The acceptance set covers the Blog directory and Photo Ideas filter, 1980s article and editor, Resources drawer, existing guides, Docs, homepage and image-to-image. It includes 320/360/390px narrow views and desktop widths through 1440px. Final visual inspection confirmed readable article cards, the three genuine output thumbnails, consistent navigation/footer groups and usable narrow-screen composers without horizontal overflow.

Selected local captures are committed under `docs/product/evidence/resources-photo-ideas/` so they survive worktree cleanup. They are local rendered pages, not production screenshots:

- [Blog directory and grouped footer, desktop](./evidence/resources-photo-ideas/blog-desktop.png).
- [1980s article, desktop](./evidence/resources-photo-ideas/article-desktop.png) and [390px](./evidence/resources-photo-ideas/article-mobile.png).
- [Same-page editor and comparison](./evidence/resources-photo-ideas/article-editor.png).
- [Resources mobile navigation](./evidence/resources-photo-ideas/resources-mobile.png).
- [Existing homepage composer, 320px](./evidence/resources-photo-ideas/homepage-320.png) and [image-to-image composer, 390px](./evidence/resources-photo-ideas/image-to-image-mobile.png).
- [Customer Docs, mobile](./evidence/resources-photo-ideas/docs-mobile.png).

The unmocked local article capture truthfully shows unavailable generation settings because generation is disabled in this environment. Separate guarded browser fixtures verified exact preset handoff, availability handling and protection of edited text/reference images. They do not establish live model availability or paid generation success.

The original machine-readable browser evidence was recorded in `.cache/resources-photo-ideas/final-browser.json` and `final-budget.json`. Final release integration is recorded in `.cache/resources-photo-ideas/release/current-main-browser.json`, with its matching `.log`, plus `updated-main-unit.log` and `docs-unit-rerun.log`. Raw caches are retained separately as local acceptance evidence and are not part of the source publication set.

## Genuine generation evidence

No new image generation was submitted for this migration, and it consumed **zero additional credits**. The images, exact prompt versions and observations are preserved from the four authorized product generations on 2026-09-29, three of which were selected for publication.

- [Recorded attempts, observations and evidence boundary](./1980s-ai-photo-validation.md).
- [Durable original, attempt and file-hash record](./evidence/1980s-ai-photo-2026-09-29.json).

The browser acceptance verifies actual served image bytes, prompt/version/model/parameter correspondence, and matching original/output files. This verifies preservation and presentation of existing evidence; it is not a new provider integration test or a success-rate study.

## Publication checks

Local checks cover permanent old-route redirects, the canonical Blog URL, published-only ordinary/image sitemaps, anonymous prompt HTML, language-view noindex behavior, unknown/draft/unauthorized-preview rejection, and preservation of existing Blog URLs. Normal legacy redirects do not load authentication or database modules; only the optional owned-draft transfer needs them.

Home-page transfer budgets remain **64 KiB for compressed HTML** and **520 KiB for the measured HTML, scripts and external CSS**. Model/article recommendation links avoid speculative route downloads; homepage recommendations load card styles without the full article stylesheet. The shared account wrapper defers its shell with SSR retained. Unused retired-directory translation copy is removed from the four public message bundles. Server-only FAQ and public-content messages stay available to server rendering but are no longer duplicated in the browser's translation payload; regression checks cover all four languages and preserve client-used namespaces.

Final measured gzip sizes after integrating `01f4314c`: **63,353 B HTML**, **434,114 B JavaScript**, and **32,932 B external CSS**; total **530,399 B**, below the unchanged **532,480 B** limit by **2,081 B**. The browser found 39 first-party scripts, seven external stylesheets and no duplicated inline stylesheets. The limited remaining headroom makes this an ongoing release gate. This is a production-build resource measurement, not a live-network speed or Core Web Vitals claim.

These local results do not establish remote CI, Git publication, deployment, live redirects or live search crawling. Use the release PR and deployment records for those statuses, and verify deployed response codes, canonical URLs, assets and authenticated return paths independently.

All tracked task-owned processes from the final production browser run exited, and port 3036 has no listener. Release verification recreated only `ezpic_effects_e2e_resources_test` to execute the guarded preview cases. The final cleanup confirmed zero users, generation jobs, credit entries and other active connections, then removed only that task-created database and verified its absence. The shared `supastarter` database and existing PostgreSQL/MinIO containers remain. App-managed worktree cleanup follows confirmed incorporation and preservation of local evidence.
