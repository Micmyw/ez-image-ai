# Effects and Guides

Implementation reference for the 2026-09-29 Effects and Blog requirements. This document describes
the local implementation and its content operation rules; it is not a production deployment record.

## Current content state

- There is **one locally published Effect**: `1980s-ai-photo`. The directory uses a wide featured
  card and three preset links; it omits search and category controls while there is one theme.
  The content status is ready for local public rendering, not proof of production deployment.
- `studio-portrait` v2, `family-snapshot` v3, and `street-portrait` v2 have matching reviewed outputs
  from the existing production EzImageAI generation flow using Nano Banana 2 Lite 1K. A common
  original was created with the built-in image tool as a fictional adult, without a real-person
  reference. Four authorized product generations consumed 20 credits; the earlier family v2
  output was rejected for red-eye and expression drift. It remains in internal evidence only.
- Original/output bytes, prompt snapshots, actual settings, dates, hashes, review observations,
  and source authorization are recorded in the [1980s acceptance record](./1980s-ai-photo-validation.md)
  and its internal evidence JSON. No trend label or broad identity-preservation claim is made.
- The reviewed effect now enters directory, homepage, related Blog and sitemap reads. Unknown
  detail URLs still return 404. Unpublished records remain excluded from public lists,
  recommendations, Blog callouts, client content, and sitemap entries.
- `/effects-preview/1980s-ai-photo` uses the shared detail template after a server-side session
  check for a non-anonymous administrator. Other callers receive 404. The preview is noindex and
  analytics-suppressed; the URL itself is not an access control mechanism.
- Existing articles retain their addresses, body copy, and publication dates:
  `/blog/ai-image-editing-prompts` and `/blog/private-image-editing-workflow`.

The preview uses the normal editor's eligibility, pricing, safety checks, and private asset rules.
Opening it or selecting a preset does not generate an image. Administrator access does not grant
free generation or authorize paid testing.

## Source boundaries

| Responsibility                                   | Source                                                                                 |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Raw Effects records and registration             | `apps/saas/content/effects/`                                                           |
| Public types, categories/tags, preset URLs       | `apps/saas/modules/effects/lib/types.ts`                                               |
| Schema and publication checks                    | `apps/saas/modules/effects/lib/validation.ts`                                          |
| Published reads and protected preview projection | `apps/saas/modules/effects/lib/content.ts`                                             |
| Shared page and editor adapter                   | `apps/saas/modules/effects/components/`                                                |
| Blog records                                     | `apps/saas/content/posts/`                                                             |
| Blog types, validation, headings, and reads      | `apps/saas/modules/public-content/lib/`                                                |
| Content attribution                              | `apps/saas/modules/effects/lib/analytics.ts`, `packages/utils/lib/growth-analytics.ts` |

Raw Effects modules and their reader are `server-only`. Public DTOs remove keyword planning fields,
private rights references, test evidence, and generation provenance references; public image credits
can still be displayed. Only a protected preview caller may request draft page content. The
validation projection exposes only effect, preset, and example IDs to other server-side validators.

One published read layer supplies directories, homepage selections, tool/model recommendations,
Blog links, and sitemap. A preset uses the same prompt record shown on its card and updates the
existing editor without starting generation or discarding an uploaded image. Modified prompts and
settings are protected before replacement. Existing quotes, jobs, recovery, billing, moderation,
and private storage remain authoritative.

## Add a second effect using content and assets

1. Create a TypeScript record in `apps/saas/content/effects/`, using `Effect` and the existing
   1980s record as field references. Give it a unique, stable lowercase ID and slug. `category`,
   `page`, and `preview` are reserved. Start with `status: "draft"` and a real `updatedAt`; do not
   prefill publication or test dates.
2. Choose existing category/tag values from `types.ts`. Add original copy, instructions,
   limitations, FAQs, a default preset, and the distinct presets required. Use actual public
   product/SKU keys and supported controls from `getImageProductSelectionContract` in
   `@repo/config/client`. Do not enter provider routes, private model IDs, credentials, costs, or
   a separate price table.
3. Import the record in `apps/saas/content/effects/index.ts` and add it to `effectRecords`. No new
   route, page template, editor, generation API, or sitemap entry is needed. Inspect the protected
   administrator preview.
4. Obtain rights for the source photos and their intended marketing use. Test every selectable
   preset through the existing product generation flow within separately authorized credit/test
   scope. Inspect identity, composition, hands, text, and the promised effect; an API success alone
   does not establish image quality.
5. Put reviewed marketing source/output files in `apps/saas/public/images/effects/<slug>/`.
   Record real dimensions and alternative text. Asset `src` values start `/images/effects/` and
   cannot contain signed URLs, query strings, external hotlinks, traversal, or private user-media
   references. Confirm that the files exist and match the reviewed test. Schema checks validate
   records and paths; they cannot establish ownership or authenticate image bytes by themselves.
6. Record each example's `presetId`, `presetVersion`, public `productKey`, exact `parameters`,
   actual `testedAt`, input/output rights records, and `provenance.kind: "product-generation"`
   with a durable internal evidence reference. Link the example from the preset's `exampleIds`.
   Add a preset test with the exact prompt, version, model, parameters, time, reviewed outcome,
   and evidence reference. Store no credentials or secrets in those references.
7. Use a verified output as the authorized cover. Set `lastTestedAt` to the latest published
   example's test time. After editorial review, set the real `publishedAt`, update `updatedAt`,
   and change the record to `published`. Remove draft-only limitations only when resolved.
8. Run focused content, route, SEO, and affected editor checks. Inspect responsive pages,
   copy/preset controls, recovery, credits, and actual comparisons. Follow the separately
   authorized release process. A local `published` record does not mean deployment or indexing.

Changing a prompt, version, model, or parameter invalidates the old test as proof of the new
configuration. Retest and replace displayed examples before publishing it. Mocks and standalone
illustrations do not satisfy the product-generation provenance gate. Static validation never polls
live providers, so a temporary outage does not break content builds or remove a useful prompt page.

`featuredOrder` is optional editorial selection, limited to four homepage cards. It is independent
of `trendStage`. Any non-`none` trend label requires `trendReviewedAt` and `trendEvidence`; competitor
coverage alone is not proof of current demand. Removing selection preserves the URL and directory
access.

## Blog relationships and reusable content

`BlogPost.relatedEffectIds` is the only maintained article-to-effect relationship. An optional
`primaryEffectId` must belong to that array. `getBlogPostsForEffect` derives reverse links. Known
draft relationships may be prepared in source, but public Blog reads remove unpublished IDs,
dependent callouts, and associated test references.

Article `contentBlocks` target a real `afterHeadingId` generated from an existing H2/H3 heading:

- `effect` references an `effectId` and `presetId` for a focused use-preset link.
- `preset-prompt` resolves the same prompt instead of maintaining duplicate text.
- `before-after` references an `effectId` and `exampleId` for a verified comparison.

Validators reject unknown relations, presets, examples, and missing insertion headings. Keep
article methods and troubleshooting distinct from the effect's prompt-and-generation purpose.
Comparison articles need real test records before publication. Privacy and general workflow
articles need no effect relationship or unrelated conversion banner.

## URLs, discovery, and retirement

English public URLs remain unprefixed. Effects use `/effects/<slug>`; Blog retains existing slug
parsing. Categories currently filter the directory without independently published category pages.
Do not create duplicate trend or category versions of a detail page.

Directories show 12 items per page. Pagination appears only when required, uses `?page=2` onward,
and retains each page's own canonical. Preset and internal-source selections use registered IDs
through `effectPath`; they canonicalize to the bare detail URL and create no sitemap items. Never
put private prompts, image data, or signed media URLs in parameters. Explicit `?lang=de|es|fr`
views follow the existing noindex/English-canonical rule.

Retirement is an explicit content operation, separate from cooling demand and model outages. Set
`status: "retired"` with a `retirement` reason and real date. Without a replacement, the proxy
returns 410 and noindex. After review establishes a genuinely equivalent alternative, set
`retirement.replacementEffectId` to a different published effect; the reader resolves its canonical
path and the proxy sends a permanent 308 redirect. Self, unknown, draft, and retired replacements
are rejected. Do not redirect unrelated retired pages to the homepage.

## Analytics and evidence limits

The existing consent-aware dispatcher records `effect_viewed`, `blog_viewed`, `prompt_copied`, and
`preset_selected`, and carries bounded context into existing upload and editor funnel events. It
uses stable effect/preset IDs and version, an allowed related article ID, an internal source label,
and a canonical entry path. Image data, private prompt text, signed URLs, and raw emails are
excluded. Draft/administrator previews suppress growth events.

This is browser attribution. It adds no durable effect/preset field to `GenerationJob`, does not
change external acquisition attribution, and does not establish server-side payment revenue
attribution. Browser completion or checkout events are not proof of settled credits or payments;
use existing server business records and verified payment outcomes for those claims.

Local tests can establish validation, filtering, consent, deduplication, safe context, and recovery
behavior. Local browser evidence establishes the UI and payloads observed in that session. Neither
establishes live analytics ingestion, real model output quality, live credits/payment settlement,
deployed cron/recovery, production availability, indexing, or rankings.

## Verification and reproduction

The [acceptance record](./effects-and-guides-verification.md) maps A01–A16 to the evidence actually
obtained, including incomplete checks. Keep historical runs separate from reruns after a fix;
overlapping test totals must not be added together.

Run SaaS Vitest, Next/Fumadocs generation, browser checks, and builds sequentially because they
share `.source`. From the repository root, the focused content/route checks can be reproduced with:

```powershell
pnpm --filter saas test modules/effects/lib/content.test.ts app/effects-routes.test.tsx app/effects-directory.test.tsx proxy.test.ts app/sitemap.test.ts
pnpm --filter saas test modules/public-content/lib/blog-content.test.ts modules/public-content/lib/pagination.test.ts modules/public-content/components/BlogDirectory.test.tsx modules/public-content/components/PublicMarkdown.test.tsx
```

For the editor readiness and selection checks, use the same affected set as the latest rerun:

```powershell
pnpm --filter saas test modules/media/components/GenerationForm.test.tsx modules/media/components/editor/ImageEditorWorkspace.test.tsx modules/media/components/MediaUploader.test.tsx modules/effects/lib/editor-selection.test.ts
pnpm --filter saas type-check
```

These commands are subsets of the full task verification, not substitutes for attribution,
handoff, or API checks when those modules change. The detailed acceptance record names the
additional focused test sources. Do not run unrelated full-workspace checks merely to publish
another reviewed recipe.

The browser scenarios are in `apps/saas/tests/effects.public-routes.spec.ts`. The nine public
scenarios require no administrator fixture and can be selected with:

```powershell
pnpm --filter saas exec playwright test --project public tests/effects.public-routes.spec.ts --grep-invert "protected editorial preview"
```

Three additional scenarios exercise the real protected page with a temporary **local** administrator
and mocked media responses. To include them, explicitly configure process-local
`E2E_EFFECTS_ADMIN_PREVIEW=true`, `E2E_EFFECTS_DATABASE_URL`, and the matching local application
`DATABASE_URL`, then run the same test file without the grep filter. The helper permits only a
matching loopback application/database and creates its own uniquely identified fixture; it never
promotes an existing account. Verify its cleanup rather than deleting accounts by a name pattern.
Do not copy credentials into this document or alter `.env.local` to satisfy this test.

For production-mode browser checking, `E2E_USE_PRODUCTION_BUILD=true` makes the Playwright server
command build and start Next with Webpack. This is a local Next production build, not a Cloudflare
deployment or a live integration test. Keep it sequential with other `.source` consumers and do not
start a competing manual build. For a separate local compilation check, use
`pnpm --filter saas exec next build --webpack` with the coordinated local test environment.

The suite captures `/effects`, `/blog`, and the prompt article at 360, 390, 768, 1280, and 1440 px;
the protected-preview group captures the editor at the same widths when that group succeeds.
Check actual overflow measurements, keyboard controls, copy feedback, and the relevant screenshots.
Synthetic content and mocked media certify software behavior only; they are never public examples.

Keep framework results and failures in `output/effects-validation/`, and the 1980s content round in
`output/1980s-content-validation/`. Update the relevant acceptance record with
the exact final command, source state, exit result, artifact paths, and cleanup outcome. Report any
unexecuted check explicitly. The real 1980s generation review is separate from mocked engineering
checks; it establishes only the four observed runs. No payment-provider test, broad model-quality
benchmark, before/after performance baseline, or production content deployment is implied.

## Release and rollback

Git publication, production deployment, and live verification are separate actions and have not
been performed by this work. A successful local build or mocked browser test does not authorize or
establish any of them.

The implementation plan is in [the task plan](../plans/2026-09-29-effects-and-guides.md). Before an
authorized release, review the final diff, validate content gates and routes, preserve existing
homepage SEO, and attach actual evidence. Roll back code with a reviewed revert through the normal
deployment process. Do not alter jobs, payments, or credits to roll back content. Withdraw content
through the retirement decision above; avoid silently deleting a public URL or substituting an
unreviewed page.
