---
name: add-a-marketing-page-or-blog-post
description: Use when adding a localized public App Router page or Content Collections blog article.
---

# Add a marketing page or blog post

## Scope

Use for public pages and blog content in `apps/marketing`. Do not put authenticated product pages here or treat legal documents as blog posts.

## Procedure

1. For a page, create `apps/marketing/app/[locale]/<route>/page.tsx`. Await `params`, call `setRequestLocale(locale)`, add localized metadata with `getTranslations`, and keep the page a Server Component unless interaction requires a small client child.
2. Add page copy to every `packages/i18n/translations/*/marketing.json`. Use `LocaleLink` from `apps/marketing/modules/i18n/routing.ts` for internal links.
3. For a blog article, add `apps/marketing/content/posts/<slug>.mdx`. Use the exact frontmatter from `apps/marketing/content-collections.ts`: `title`, `date`, `authorName`, `tags`, `published`, and optional image/author/excerpt fields.
4. Add localized post variants as `<slug>.<locale>.mdx`; the unsuffixed file is the default locale. Keep the same base slug. Missing variants fall back through `getLocalizedDocumentWithFallback`.
5. Do not edit `apps/marketing/.content-collections/generated`. Generate it with:
   ```bash
   pnpm --filter marketing generate
   ```
6. Check catch-all conflicts. The locale-aware routes are `app/[locale]/blog/[...path]` and `app/[locale]/[...rest]`; do not create an extra `(marketing)` segment assumed from another starter.
7. Add/update Playwright coverage in `apps/marketing/tests` when routing or browser-visible behavior changes; a copy-only post may use generation/build verification instead. Run:
   ```bash
   pnpm --filter marketing test
   pnpm --filter marketing e2e:ci
   pnpm format
   pnpm lint
   pnpm type-check
   ```

## Canonical reference

`apps/marketing/app/[locale]/contact/page.tsx` is a localized page. `apps/marketing/content/posts/first-post.mdx` and `apps/marketing/content/posts/first-post.de.mdx` demonstrate default and localized article naming.

## Done

The route/post resolves at default and localized URLs, metadata and fallback behavior are correct, only the generator writes `.content-collections`, justified browser coverage (or a documented copy-only skip) is complete, and marketing tests/gates pass.

## Common mistakes

- Hand-editing `.content-collections/generated`.
- Naming the default post `<slug>.en.mdx`; the current default is unsuffixed.
- Omitting `setRequestLocale` on a localized page.
- Assuming blog routes use `[slug]`; they use `[...path]`.
- Requiring a translated post file when fallback to the unsuffixed default is intentional.
