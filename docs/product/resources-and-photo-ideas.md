# Resources and interactive Photo Ideas

## Public information architecture

| Navigation | Purpose                                 | Destinations                     |
| ---------- | --------------------------------------- | -------------------------------- |
| AI Image   | General image creation and editing      | Image generator, Image to Image  |
| AI Tools   | A specific operation or output workflow | Photo to Coloring Page           |
| AI Models  | Choose an available image model         | Existing model pages and catalog |
| Resources  | Discover ideas, learn and get help      | Blog, Editing Examples, Docs     |
| Pricing    | Understand plans and credits            | Existing pricing page            |

Headers, mobile drawers and grouped footers use this same taxonomy. Resources is a navigation group; it does not introduce an empty `/resources` landing page. Editing Examples remains the existing example gallery. Blog contains both practical guides and Photo Ideas.

Photo Ideas are editorial topics, such as 1980s portraits, whose value comes from the examples, creative direction and reusable prompts. An optional shared recipe lets readers try the idea without leaving the article. Ordinary Blog guides do not need an editor.

## One content identity

The 1980s topic lives at `/blog/1980s-ai-photo`. Its Blog record owns the article title, description, dates, category, publication and public discovery. A recipe attachment supplies the three validated presets, exact prompts/settings, source/output pairs and retained test evidence.

The old `/effects/1980s-ai-photo` address redirects permanently to this article. The old `/effects` directory redirects to `/blog?category=photo-ideas`. Existing unrelated Blog article addresses remain unchanged. Search metadata, structured breadcrumbs, sitemap, internal recommendations and restored editor return paths point to the Blog identity.

Unknown legacy slugs must return 404. Draft articles or unreviewed recipes must not become public through a redirect, recommendation, sitemap, metadata, preview or alternative spelling of a URL. Explicit language views remain noindex with English canonical URLs.

## Reusable recipe capability

Preserve the existing server-only recipe/evidence reader and editor adapter. Its internal legacy Effects names are compatibility implementation details, not a second public content catalog.

- Stable recipe and preset IDs survive the public URL migration.
- Displayed, copied and applied prompts come from the same preset version.
- Each published preset keeps matching real output evidence, authorized source assets, a tested product/parameter combination and truthful limitations.
- Internal evidence references and unpublished copy remain server-side. Public serialization strips private evidence and rights records.
- Both the Blog article and its attached recipe must be publishable before the Photo Idea is discoverable.
- Preview remains administrator-only and noindex; it does not satisfy public content acceptance.

The editor remains responsible for uploads, current model availability, quotes, account/guest eligibility, moderation, idempotency, job recovery and credits. Selecting a preset only prepares editable controls. It does not upload automatically, submit a generation or spend credits. Preserve confirmation before replacing a user's custom prompt/settings and preserve their selected source image.

## Adding a Photo Idea

1. Create or reuse a shared recipe with stable IDs, tested prompts, supported settings and reviewed source/output assets. Retain rights and exact generation evidence.
2. Add a factual Blog record in `apps/saas/content/posts`, with the Photo Ideas category/type and an optional recipe attachment. Write useful context, differences between the looks, practical instructions and observed limitations.
3. Register the route identity used for safe draft/checkout returns. It contains only public IDs/slugs, never prompt text, assets, provider routes or credentials.
4. Keep the article and recipe private until their validation checks pass. Do not bypass the evidence gate to populate a directory.
5. Verify that the new Blog route, discovery card, preset links, copied text, editor input and canonical all agree. Add a related guide only when it contributes different, evidence-backed material.

Hotness is a recommendation state, not a permanent category or a reason to delete an article. Avoid duplicate pages for near-identical phrases.

## Verification and release boundary

The migration preserves the original 1980s assets and recorded generation observations. Local content, route and browser checks do not constitute new model tests. No new paid generations are required for this navigation/content migration.

Implementation planning and local acceptance are recorded in `docs/plans/2026-10-04-resources-photo-ideas.md` and the task verification report. Git publication, deployment and live acceptance are separate stages. Before release, confirm permanent legacy redirects and a single canonical Blog entry; after release, verify actual HTTP responses and the public article's assets.
