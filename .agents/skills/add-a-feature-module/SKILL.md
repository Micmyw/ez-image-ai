---
name: add-a-feature-module
description: Use when adding a cohesive SaaS product feature with routes, UI, data access, and navigation.
---

# Add a feature module

## Scope

Use for a feature that owns multiple components, hooks, or server interactions. Do not create a module for a single reusable primitive; place shared UI in `packages/ui` and shared utilities in the owning package.

## Procedure

1. Choose account or organization scope before creating files. Put feature code in `apps/saas/modules/<feature>/{components,hooks,lib}` and keep `"use client"` at the smallest interactive boundary.
2. Add App Router pages under:
   - account: `apps/saas/app/(authenticated)/(main)/(account)/<route>/page.tsx`
   - organization: `apps/saas/app/(authenticated)/(main)/(organizations)/[organizationSlug]/<route>/page.tsx`
3. Reuse the authenticated guards and providers in `apps/saas/app/(authenticated)/layout.tsx`. Organization pages inherit `getActiveOrganization` validation from the `[organizationSlug]/layout.tsx`.
4. Add server operations under `packages/api/modules/<feature>` and register its router in `packages/api/orpc/router.ts`. Put persistence behind matching exports in both `packages/database/prisma/queries` and `packages/database/drizzle/queries` when the feature adds data access.
5. Fetch client data with `orpc` from `apps/saas/modules/shared/lib/orpc-query-utils.ts` and TanStack Query. Prefetch in a Server Component only when initial rendering benefits.
6. Add translated labels to every `packages/i18n/translations/*/saas.json`. Add navigation in `apps/saas/modules/shared/components/NavBar.tsx`; for a new account-level top slug, add it to `config.organizations.forbiddenOrganizationSlugs` in `packages/auth/config.ts`.
7. Add focused Vitest coverage and Playwright coverage for the critical user journey.
8. Run focused tests, `pnpm format`, `pnpm lint`, and `pnpm type-check`.

## Canonical reference

The AI feature spans `apps/saas/modules/ai/components/AiChat.tsx`, `apps/saas/app/(authenticated)/(main)/(account)/chatbot/page.tsx`, and `packages/api/modules/ai/procedures/stream-message.ts`.

## Done

Account/organization URLs resolve through the intended route group, server access and both query layers enforce the chosen scope, root router/navigation/reserved slug/i18n wiring is complete, and critical unit/E2E tests plus gates pass.

## Common mistakes

- Creating a literal `/organization/[slug]` URL; current organization URLs are `/<organizationSlug>/...`.
- Moving browser-only fetching into a large client page.
- Adding a route but omitting its reserved slug or translated navigation label.
- Importing app aliases from workspace packages.
- Adding only the Prisma query for a feature whose Drizzle query layer is maintained in parallel.
