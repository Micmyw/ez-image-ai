# Resources and Photo Ideas: local acceptance

Date: 2026-10-04. Plan: [Resources and interactive Photo Ideas](../plans/2026-10-04-resources-photo-ideas.md). Product rules: [Resources and Photo Ideas](./resources-and-photo-ideas.md).

Implementation is in `codex/resources-photo-ideas`, based on `1b3c9dc2c2b5ee3e9dd0b05e3fea02141908d04b`, in the Codex-managed `resources-photo-ideas` worktree. The shared checkout and its existing work are preserved. This report records local implementation and verification before publication. Git publication and deployment have separate release records.

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

At the original acceptance, `LandingGenerator`, `GenerationForm`, `ImageEditorWorkspace`, generation styles, the recipe record, public example assets and durable generation-evidence JSON had no changes against the starting commit. Release integration subsequently retained the coloring-preview changes from `3b781797`; the three composer components and original 1980s assets/evidence are unchanged relative to that remote main commit. The `media` translation namespace and homepage copy are unchanged in all four locales. Browser assertions that still described an older composer were updated to the verified starting implementation: its current labels, native ratio selector, prompt/reference ordering and optional reference on the shared homepage/image-to-image form. The production form was not changed to satisfy those assertions.

The local browser environment uses an isolated `ezpic_effects_e2e_resources_test` database on loopback. Existing migrations initialized it; no schema change was added. Generation and billing remain disabled, and interactive generation controls use local browser fixtures without submitting generation or payment requests. Temporary administrator accounts are created and removed by the existing guarded fixture. The local build uses a nonfunctional placeholder mail key; no mail is sent.

## Actual page screenshots

Final captures are produced by the public browser suites under `apps/saas/.cache/resources-photo-ideas-final/`. These are local rendered-page evidence, not production-deployment evidence.

The acceptance set covers the Blog directory and Photo Ideas filter, 1980s article and editor, Resources drawer, existing guides, Docs, homepage and image-to-image. It includes 320/360/390px narrow views and desktop widths through 1440px. Final visual inspection confirmed readable article cards, the three genuine output thumbnails, consistent navigation/footer groups and usable narrow-screen composers without horizontal overflow.

Selected local captures are committed under `docs/product/evidence/resources-photo-ideas/` so they survive worktree cleanup. They are local rendered pages, not production screenshots:

- [Blog directory and grouped footer, desktop](./evidence/resources-photo-ideas/blog-desktop.png).
- [1980s article, desktop](./evidence/resources-photo-ideas/article-desktop.png) and [390px](./evidence/resources-photo-ideas/article-mobile.png).
- [Same-page editor and comparison](./evidence/resources-photo-ideas/article-editor.png).
- [Resources mobile navigation](./evidence/resources-photo-ideas/resources-mobile.png).
- [Existing homepage composer, 320px](./evidence/resources-photo-ideas/homepage-320.png) and [image-to-image composer, 390px](./evidence/resources-photo-ideas/image-to-image-mobile.png).
- [Customer Docs, mobile](./evidence/resources-photo-ideas/docs-mobile.png).

The unmocked local article capture truthfully shows unavailable generation settings because generation is disabled in this environment. Separate guarded browser fixtures verified exact preset handoff, availability handling and protection of edited text/reference images. They do not establish live model availability or paid generation success.

The original machine-readable browser evidence was recorded in `.cache/resources-photo-ideas/final-browser.json` and `final-budget.json`, with matching `.log` files. Raw caches are retained separately as local acceptance evidence and are not part of the source publication set.

## Genuine generation evidence

No new image generation was submitted for this migration, and it consumed **zero additional credits**. The images, exact prompt versions and observations are preserved from the four authorized product generations on 2026-09-29, three of which were selected for publication.

- [Recorded attempts, observations and evidence boundary](./1980s-ai-photo-validation.md).
- [Durable original, attempt and file-hash record](./evidence/1980s-ai-photo-2026-09-29.json).

The browser acceptance verifies actual served image bytes, prompt/version/model/parameter correspondence, and matching original/output files. This verifies preservation and presentation of existing evidence; it is not a new provider integration test or a success-rate study.

## Publication checks

Local checks cover permanent old-route redirects, the canonical Blog URL, published-only ordinary/image sitemaps, anonymous prompt HTML, language-view noindex behavior, unknown/draft/unauthorized-preview rejection, and preservation of existing Blog URLs. Normal legacy redirects do not load authentication or database modules; only the optional owned-draft transfer needs them.

Home-page transfer budgets remain **64 KiB for compressed HTML** and **520 KiB for the measured HTML, scripts and external CSS**. Model/article recommendation links avoid speculative route downloads; homepage recommendations load card styles without the full article stylesheet. The shared account wrapper defers its shell with SSR retained. Unused retired-directory translation copy is removed from the four public message bundles.

Pre-integration measured gzip sizes: **64,451 B HTML**, **434,711 B JavaScript**, and **33,164 B external CSS**; total **532,326 B**, below the unchanged **532,480 B** limit. The browser found 39 first-party scripts and seven external stylesheets. The total budget has only 154 B of headroom and remains a release gate for future changes. This is a production-build resource measurement, not a live-network speed or Core Web Vitals claim.

These local results do not establish remote CI, Git publication, deployment, live redirects or live search crawling. Use the release PR and deployment records for those statuses, and verify deployed response codes, canonical URLs, assets and authenticated return paths independently.

All tracked task-owned preview/build/browser processes have exited, and port 3036 has no listener. Before removing the disposable database, verification found zero users, generation jobs, credit-ledger entries and other active database connections. Only `ezpic_effects_e2e_resources_test` was dropped; the shared `supastarter` database and existing PostgreSQL/MinIO containers remain. At the end of original local acceptance, the unmerged app-managed worktree and its local captures were retained for review; release cleanup follows confirmed incorporation and evidence preservation. No temporary server is left running.
