# Effects and Guides implementation

Source: `EzImageAI_Effects_Blog_Codex_Requirements.md`, version 2026-09-29.

## Verified integration points

- Public pages live in `apps/saas/app/(public)`; English canonical routing is in
  `apps/saas/proxy.ts`, metadata in `modules/public-content/lib/metadata.ts`, and
  approved URLs in `app/sitemap.ts`.
- Blog records are TypeScript content in `apps/saas/content/posts`, read by
  `modules/public-content/lib/content.ts` and rendered by `PublicMarkdown`.
  Preserve both existing article URLs, original body text, and publication dates.
- Guest edits use `LandingGenerator` and the existing private draft handoff.
  Registered edits use `RegisteredEditor`, `CreatorWorkspace`,
  `ImageEditorWorkspace`, and `GenerationForm`. Preserve the authoritative
  catalog, permissions, quotes, idempotency, moderation, and private results.
- Analytics uses the consent-aware growth dispatcher in `packages/utils`.
  Extend bounded editorial context without introducing another analytics system.

## Work packages

1. Validate file-driven Effects content, versions, relationships, and evidence.
   Keep raw draft records on the server. Seed three distinct 1980s draft presets.
2. Integrate preset selection with the existing editor. Protect edited prompts,
   preserve images, validate supported defaults, and keep submission explicit.
   Reuse existing login, payment, and job recovery.
3. Upgrade Blog cards, filtering, pagination, reading layout, heading anchors,
   copyable prompt blocks, and publication-filtered effect relationships.
4. Add Effects directory, shared detail template, protected editorial preview,
   examples, instructions, and relevant recommendations. Keep the existing
   Plus Jakarta Sans typography and violet/dark palette; distinguish examples,
   editable prompts, and private results with clear labels and layout.
5. Add persistent desktop/mobile navigation, conditional home selections,
   relevant tool/model links, sitemap/metadata, and retirement responses.
6. Verify content/editor behavior, privacy, routes, SEO, old Blog preservation,
   and widths 360/390/768/1280/1440. Run SaaS tests, type generation, browser
   checks, and production build sequentially because they share `.source`.

## Publication boundary

The first 1980s effect remains a draft until all three presets have authorized
source images and real product outputs tied to the exact prompt, model, settings,
and preset version. Mock/local tests certify software behavior only. No paid
generation, commit/push, production migration, or deployment is authorized here.
The directory stays usable when no effect is published and exposes no draft data.

## Evidence to deliver

Record focused test/build commands and results, responsive screenshots, 200/404/
410/canonical checks, any genuine blockers, and instructions for adding a second
effect using only content/assets. Separate local completion from live-service and
production evidence. Stop temporary task-owned processes after preview checks.
