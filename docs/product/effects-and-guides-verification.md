# Effects and Guides acceptance record

> Historical framework checkpoint. The content state below describes the earlier draft-only run.
> The later [1980s content acceptance record](./1980s-ai-photo-validation.md) records real generations,
> reviewed imagery, the locally published first effect, and the new page verification. Do not add
> overlapping test totals or treat this earlier empty-directory evidence as completed content.

Local engineering verification completed on 2026-09-29. All **12 distinct browser scenarios** have
a passing result, across a full run and a focused rerun. The 1980s effect remains a draft because
real authorized generation examples are not available. No production publication is claimed.

Source state: branch `main`, HEAD `111d9549d4ab5b96ded40f0a5a083469e5274673`, with uncommitted
Effects/Guides work and preserved concurrent changes in the same checkout. This is not an immutable
release artifact. Configuration-only addition of another effect is documented in
[Effects and Guides](./effects-and-guides.md#add-a-second-effect-using-content-and-assets).

## Verified checks

| Check                             | Result                                          | Scope                                                                                                                     |
| --------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Focused SaaS tests                | 27 files, 292 tests passed                      | Earlier coordinated run.                                                                                                  |
| Editor-readiness rerun            | 4 files, 49 tests passed                        | Includes readiness changes; overlaps the earlier run, so the totals are not added.                                        |
| API regression tests              | 5 tests passed                                  | Effects return-path behavior in `complete-guest-link-intent.test.ts`.                                                     |
| SaaS type check                   | Exit 0                                          | `pnpm --filter saas type-check`.                                                                                          |
| Next production build             | Passed TypeScript; generated 55/55 static pages | `pnpm --filter saas exec next build --webpack`; local compilation only.                                                   |
| Public browser scenarios          | 9 passed                                        | Publication boundaries, navigation, old articles, copy/TOC, and responsive checks.                                        |
| Administrator browser scenarios   | 3 passed in the focused rerun                   | Real local session/role access with mocked media responses; no Generate click.                                            |
| Formatting, lint, locale messages | Focused checks passed                           | 32-file formatting check and Effects/public-content Oxlint passed; four-locale key parity and ICU rendering were checked. |
| Cleanup                           | Completed                                       | Task processes stopped, port 3195 closed, temporary local administrator/database removed.                                 |

The full browser run recorded **11 passed and 1 failed**. The remaining failure targeted a visually
hidden ratio radio; the test was changed to click its visible label and assert checked state. The
subsequent three-admin rerun passed in 11.5 seconds, without another product-code change. Thus all
12 distinct scenarios have a pass; this must not be described as a single 12/12 run.

The latest readiness command was:

```powershell
pnpm --filter saas test modules/media/components/GenerationForm.test.tsx modules/media/components/editor/ImageEditorWorkspace.test.tsx modules/media/components/MediaUploader.test.tsx modules/effects/lib/editor-selection.test.ts
```

Type-check/build success is recorded in tool execution output; no separate complete log file was
created. The build used process-local placeholder database/auth/mail configuration and
`MEDIA_GENERATION_ENABLED=false`. It reported Hono dynamic-dependency warnings and absent
Google/GitHub OAuth configuration. No real generation, payment, or external-service success is
inferred from this build.

## Evidence artifacts and preview

- [Full browser report](../../output/effects-validation/playwright-final-report/index.html),
  retaining its 11-pass/1-fail outcome.
- [Verified admin rerun report](../../output/effects-validation/playwright-admin-verified-report/index.html).
- Fifteen public screenshots in
  `output/effects-validation/playwright-final-results/effects.public-routes-Guid-bf2d3--all-five-acceptance-widths-public/`:
  `/effects`, `/blog`, and the prompt guide at 360, 390, 768, 1280, and 1440 px.
- Five protected-editor full-page captures plus 360/1440 px viewport captures in
  `output/effects-validation/playwright-admin-verified-results/effects.public-routes-prot-ac425--fits-all-acceptance-widths-public/`.
- [Source-preservation screenshot](../../output/effects-validation/playwright-admin-verified-results/effects.public-routes-prot-163c1-and-no-automatic-generation-public/effect-preview-source-preserved.png)
  from the passing preset interaction scenario.
- [Process cleanup receipt](../../output/effects-validation/process-cleanup.json).
- [Task source manifest](../../output/effects-validation/source-manifest.json), recording HEAD,
  grouped task file paths, and SHA256 values after the final documentation update.

The coordinator visually inspected protected-editor 360/1440 px viewport and full-page captures.
All five widths passed automated overflow checks and have screenshots. The other three widths are
not described as separately visually inspected. Images and reports reflect the combined checkout,
including preserved concurrent work.

The existing shared development server remains available for manual review at
[the Effects directory](http://127.0.0.1:3002/effects) and
[the Guides directory](http://127.0.0.1:3002/blog). Both returned 200 with the expected titles during
the coordinator's final check. This pre-existing service is not the production bundle used by this
task's browser tests and was intentionally left running.

## A01–A16 evidence matrix

| ID  | Requirement                               | Local evidence                                                                                                                                                                                                                                                                                             | Boundary                                                                                                                                        |
| --- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| A01 | Add a second effect through configuration | `content.test.ts` registers a synthetic second record and derives directory, featured, related, and product reads without another route/editor. The main guide documents the content/assets registration procedure.                                                                                        | A real second effect still needs reviewed copy, authorized assets, and genuine generation evidence.                                             |
| A02 | Draft isolation                           | Content/read tests exclude the 1980s draft and redact private evidence; route tests cover public/preview access. Browser checks inspect directory, Blog, article, and sitemap responses for draft URL/title/prompt leakage and confirm public draft/unauthorized preview 404s.                             | Local responses and server-only content boundaries; no production crawl or deployed bundle certification.                                       |
| A03 | Homepage reachability                     | Browser checks confirm permanent homepage navigation/footer links to `/effects`, the existing homepage H1, and no draft link. Published-reader/directory fixtures cover eligible detail access.                                                                                                            | There are zero actual published Effects; no live published example was traversed.                                                               |
| A04 | Copy and preset behavior                  | Public copy/keyboard/fallback tests pass. The admin interaction rerun passes three presets, prompt/settings replacement confirmation, uploaded-source retention, copy feedback, and zero generation mutations.                                                                                             | Media responses are mocked. This proves interaction behavior, not actual image generation or charges.                                           |
| A05 | Model, parameters, and quote              | Validation rejects wrong SKUs, unsupported controls, and stale examples. Selection/readiness tests prevent silent substitution and premature interaction; the admin unavailable-model/invalid-preset case passes.                                                                                          | Catalog browser responses are mocked; no real quote-to-charge/provider transaction was run.                                                     |
| A06 | Generation and deduplication              | Existing submission paths remain in use. Form/selection and browser tests prevent automatic submission; generation-hook/analytics tests preserve request-start context and deduplicate terminal observations.                                                                                              | Analytics deduplication is not credit-ledger proof. No live paid duplicate-click/reload generation was performed.                               |
| A07 | Login/payment return and recovery         | Return allowlists, guest-draft scope/expiry, handoff cookies, `/draft/continue`, guest-trial hooks, and five API tests cover effect/preset continuity, preserved private prompts, and lost-file notices.                                                                                                   | No real payment return or newly charged generation/asset recovery was exercised.                                                                |
| A08 | Existing Blog retained                    | Both old URLs, titles, body excerpts, original publication dates, canonical links, and organization author data pass browser checks. Content/render tests cover fallback, headings, and copyable original prompts.                                                                                         | Local route/content regression evidence, not indexing or traffic evidence.                                                                      |
| A09 | Content relationships                     | Blog `relatedEffectIds` is the single maintained relation. Validation rejects unknown targets/anchors; public readers remove draft relations. Preset/example components resolve shared data and reverse reads derive guides.                                                                               | Public pages correctly omit the 1980s callout. A real published effect-to-article browser journey requires release-ready content.               |
| A10 | HTTP status and SEO                       | Browser checks cover current 200/404 responses, empty-directory noindex, canonical links, reserved categories, invalid second pages, and no draft sitemap item. Proxy tests cover actual 410/308 response objects with synthetic retirement records; pagination/sitemap tests cover later-page canonicals. | Retirement and larger published catalogs are fixture-tested, not live production requests.                                                      |
| A11 | Server-visible content                    | Article response checks read copy directly from HTML. Markdown/directory SSR tests cover headings, prompts, descriptive links, and paginated anchors; authored Effects content is separate from editor initialization.                                                                                     | Protected draft content is intentionally unavailable to public crawlers; real published Effects are absent.                                     |
| A12 | Authentic authorized examples             | Publication validation requires rights and product-generation provenance matching the exact current prompt, version, product, parameters, and test time; untested or illustrative outputs cannot pass.                                                                                                     | **Not satisfied for public content.** No authorized 1980s source/output pairs or real quality tests exist. All three presets remain draft.      |
| A13 | Analytics/privacy                         | Analytics and hook tests cover consent/withdrawal, bounded IDs, allowed Blog sources, expiry, preview suppression, request-start scope, task hashing, and completion deduplication. Public DTO tests strip internal rights/test evidence.                                                                  | Browser attribution only; no durable `GenerationJob` effect fields, live ingestion, or server-verified revenue attribution was established.     |
| A14 | Small screens and keyboard                | All five required widths pass public and protected-editor overflow checks. Mobile TOC, keyboard anchors, copy feedback, and preset controls are covered. Public/admin screenshots are retained; 360/1440 px admin images were visually inspected.                                                          | No before/after performance baseline or claimed speed improvement. Other widths have automated evidence, not separate visual inspection claims. |
| A15 | Existing functionality                    | Focused editor, landing, public-route, guest-handoff, and API checks reuse existing auth/quote/job interfaces. Old Blog and homepage H1/navigation checks pass.                                                                                                                                            | Not a live regression certificate for every model, payment, moderation, or provider path. Concurrent homepage work is separate.                 |
| A16 | Engineering verification                  | Recorded SaaS/API tests, readiness rerun, type check, 55/55-page Next build, and all 12 distinct browser scenarios have passing results within their stated scopes; cleanup is verified.                                                                                                                   | Overlapping runs are not added together. Local success does not establish deployment, real generation quality, or live integrations.            |

Focused test sources include `apps/saas/modules/effects/lib/`, `app/effects-routes.test.tsx`,
`app/effects-directory.test.tsx`, `proxy.test.ts`, `app/sitemap.test.ts`, Blog content/render tests,
media generation/guest/handoff tests, and
`packages/api/modules/media/procedures/complete-guest-link-intent.test.ts`. Synthetic publication
fixtures remain test-only. Reproduction commands and the local administrator fixture boundary are
in [the main guide](./effects-and-guides.md#verification-and-reproduction).

## Changed-module boundary

The [source manifest](../../output/effects-validation/source-manifest.json) is the actual task file
inventory. It excludes the concurrent-only files listed below and marks shared files that may
contain both tasks' changes. Its hashes identify the combined local file contents, not individual
hunks or an immutable Git release.

Effects/Guides changes comprise:

- New content/schema/read projections, directory/detail/protected preview, shared cards/comparisons,
  preset adapter/recovery helpers, and Effects styles.
- Selected existing-editor changes for preset application, recovered-state readiness, private source
  preservation, result placement, and allowlisted effect returns. These span `LandingGenerator`,
  `GenerationForm`, `RegisteredEditor`, `ImageEditorWorkspace`, `CreatorWorkspace`, guest
  workspaces/hooks, `/try`, `/draft/continue`, draft handoff, and `complete-guest-link-intent`.
- Blog metadata/relations, directory/article layout, headings/TOC, copying, verified-example
  references, pagination, and safe public reads.
- Permanent navigation and eligible home/tool/model recommendations, proxy/metadata/sitemap rules,
  four-locale UI messages, product docs, and related changelog entries.
- Bounded content context in the existing browser analytics and media hooks. No new generation
  backend, credit system, persistent business-state schema, or analytics service was created.

The original verification preserved concurrent homepage/editor layout work. The user's subsequent
layout correction restores the homepage's standard composer, moves page-specific overrides back
into the scoped `image-to-image.css`, and removes `editor-composer.css`. Effects recommendations
follow the original model/example content. Gallery and dock component changes remain intact.
See [the layout restoration verification](editor-layout-restoration.md) for the later checks.
Shared files can contain multiple tasks' changes; review individual changes rather than reverting
or publishing a whole file based on this record.

## Cleanup and remaining publication boundary

Six task-process snapshots contained 26 process records; none remained running at cleanup. Port
3195 was closed. The task-owned database `ezpic_effects_e2e_20260929_2214` had zero connections before
removal and was verified absent afterward; its local receipt records removal at
`2026-09-29T14:38:10.328Z`. The temporary local administrator was removed. Only this task's two
transient scripts/config files under `apps/saas/.cache` were removed. The shared PostgreSQL service
and the pre-existing development server on port 3002 were preserved.

The outstanding content-release requirement is A12: real authorized inputs, product outputs, and
quality review for every 1980s preset. There were no real generation/payment tests, no measured
performance baseline, no commit/push, no production deployment, and no live-service verification.
The directory remains useful with zero published effects while this evidence is obtained.
