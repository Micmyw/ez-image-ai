---
name: add-organization-scoped-feature
description: Use when implementing tenant-owned data or behavior under the active organization context.
---

# Add an organization-scoped feature

## Scope

Use when records, routes, billing, or actions belong to an organization. Do not infer tenant access from a URL slug or client context alone.

## Procedure

1. Add pages below `apps/saas/app/(authenticated)/(main)/(organizations)/[organizationSlug]`. The public URL is `/<organizationSlug>/...`, not `/organization/<slug>/...`.
2. Let the segment layout call `getActiveOrganization(organizationSlug)` and return `notFound()` for unavailable organizations. Reuse its prefetched `activeOrganizationQueryKey`.
3. In client UI, read `activeOrganization`, `activeOrganizationUserRole`, and `isOrganizationAdmin` from `useActiveOrganization()` in `apps/saas/modules/organizations/hooks/use-active-organization.ts`.
4. Add `organizationId` and its foreign key/index to Prisma, mirror PostgreSQL/MySQL/SQLite Drizzle definitions, generate, and migrate. Keep the Prisma and Drizzle query implementations tenant-scoped and behaviorally aligned.
5. In oRPC handlers, derive the user from `context.user` and verify `organizationId` with `verifyOrganizationMembership` or `verifyOrganizationBillingManagement` from `packages/api/modules/organizations/lib/membership.ts`.
6. Scope every database read, update, and delete by the verified organization. Never fetch by record ID and authorize only after returning or mutating it.
7. Add organization navigation in `apps/saas/modules/shared/components/NavBar.tsx` using its `basePath`; gate admin-only links with `isOrganizationAdmin`.
8. Test member denial, cross-organization denial, allowed roles, and missing organizations. Run API/SaaS tests and repository gates.

## Canonical reference

`packages/api/modules/payments/procedures/create-checkout-link.ts` verifies organization billing authority before loading customer data, and `apps/saas/app/(authenticated)/(main)/(organizations)/[organizationSlug]/layout.tsx` validates the route organization before rendering.

## Done

The route layout rejects inaccessible slugs, every server operation verifies membership/role before data access, both query layers scope all reads/writes by organization, navigation uses `basePath`, cross-tenant tests fail closed, and repository gates pass.

## Common mistakes

- Trusting `useActiveOrganization()` as server authorization.
- Accepting an organization ID without checking the authenticated user.
- Using only `isOrganizationAdmin` in the browser to protect an action.
- Forgetting compound uniqueness or indexes that include `organizationId`.
- Scoping the API procedure but leaving a database update/delete keyed only by record ID.
