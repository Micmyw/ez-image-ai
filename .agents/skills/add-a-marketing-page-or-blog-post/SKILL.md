---
name: add-a-marketing-page-or-blog-post
description: Use when adding a same-origin public App Router page or factual EzPic blog article to the SaaS application.
---

# Add a marketing page or blog post

## Scope

Use for public pages and Blog content in `apps/saas`. Do not place authenticated product pages in
the public route group or publish starter/demo content as EzPic facts.

## Procedure

1. Add public pages below `apps/saas/app/(public)` and use
   `apps/saas/modules/public-content/lib/metadata.ts` for an explicit same-origin canonical and
   robots policy. Every public page owns exactly one visible `h1`.
2. Public SEO URLs use stable English via `apps/saas/proxy.ts`; account routes retain the locale
   cookie through `next-intl`. Add new public HTML routes to the proxy matcher. Do not add a root
   locale segment because it conflicts with organization slugs. Translate reusable UI strings in
   all existing locale bundles, following the adjacent marketing or SaaS message scope.
3. Add factual Blog records below `apps/saas/content/posts` and register them in
   `apps/saas/modules/public-content/lib/content.ts`. Use stable lowercase slugs, truthful dates and
   descriptions, and English fallback only where the content contract allows it.
4. The reviewed Blog articles and five public Docs topics are approved for indexing as of
   2026-09-12. New Docs require explicit `indexable: true` after content review; Changelog,
   Contact, and Docs artifacts remain `noindex, follow`. The sitemap contains the four core
   routes, Blog index and published articles, and indexable Docs. Do not manufacture `lastmod`.
5. Update focused Vitest coverage in `apps/saas/app/public-routes.test.tsx` and Playwright coverage
   in `apps/saas/tests/public-routes.spec.ts` when browser-visible behavior changes. Run:
   ```bash
   pnpm --filter saas test app/public-routes.test.tsx app/sitemap.test.ts app/robots.test.ts modules/docs/lib/source.test.ts
   pnpm --filter saas exec playwright test --project public
   pnpm --filter saas type-check
   ```
   Run these sequentially: Vitest and Next generate different Fumadocs output in `.source`.
   The `public` Playwright project does not create database authentication fixtures.

## Canonical reference

`apps/saas/app/(public)/blog/[...path]/page.tsx` and
`apps/saas/content/posts/private-image-editing-workflow.ts` are the canonical route and factual
content examples.

## Done

The route/post resolves on the SaaS origin, metadata and fallback behavior are correct, no demo
claims or private Provider details are published, and focused SaaS tests pass.

## Common mistakes

- Adding a locale-prefixed root route that collides with organization slugs.
- Adding a public page without an explicit canonical, robots policy, or single `h1`.
- Reintroducing starter articles, fake authors, simulated forms, or invented product claims.
- Adding an indexable route without updating and testing the approved sitemap contract.
