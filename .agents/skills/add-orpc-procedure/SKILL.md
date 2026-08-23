---
name: add-orpc-procedure
description: Use when adding an oRPC API endpoint, query, or mutation and consuming it through TanStack Query.
---

# Add an oRPC procedure

## Scope

Use for typed RPC/OpenAPI application endpoints. Do not add a Next.js route handler when the operation belongs in the shared API, or expose unauthenticated data through `publicProcedure` by convenience.

## Procedure

1. Add `packages/api/modules/<module>/procedures/<verb-noun>.ts`.
2. Select `publicProcedure`, `protectedProcedure`, or `adminProcedure` from `packages/api/orpc/procedures.ts`. Add module middleware with `.use(...)` before `.route(...)`.
3. Define complete `.route(...)` metadata with a unique method/path, tags, summary, and description. Paths start below Hono's `/api` base (for example `/organizations/generate-slug`). Add Zod `.input(...)` when input exists and always define `.output(...)`. Keep a schema inline when it is procedure-only; export reusable client-facing schemas from `packages/api/modules/<module>/types.ts`.
4. Keep persistence in exported functions under `packages/database`; do not access the Prisma client directly from an API procedure.
5. In the handler, derive user identity from `context.user`. For organization input, verify membership or billing authority with helpers such as `verifyOrganizationMembership` in `packages/api/modules/organizations/lib/membership.ts`.
6. Export the procedure from `packages/api/modules/<module>/router.ts`. For a new module, add its router to `packages/api/orpc/router.ts`.
7. Consume the typed procedure through `orpc` from `apps/saas/modules/shared/lib/orpc-query-utils.ts` with `useQuery(orpc.<module>.<name>.queryOptions(...))` or `useMutation(orpc.<module>.<name>.mutationOptions(...))`. Do not duplicate a shared Zod schema in the app.
8. Add a co-located `*.test.ts` using `call` from `@orpc/server` and `{ context: { headers: new Headers() } }`. For protected/admin procedures, mock `auth.api.getSession` so the real middleware creates user/session context; cover validation, auth/tenant checks, success, and mapped `ORPCError` codes.
9. Run:
   ```bash
   pnpm --filter @repo/api test
   pnpm format
   pnpm lint
   pnpm type-check
   ```

## Canonical reference

`packages/api/modules/organizations/procedures/generate-organization-slug.ts` shows route/input/output chaining and router registration. `packages/api/modules/payments/procedures/create-checkout-link.ts` shows protected organization authorization. `apps/saas/modules/payments/hooks/purchases.tsx` consumes oRPC query options with TanStack Query.

## Done

The module/root routers expose the procedure, its OpenAPI method/path and Zod input/output agree with runtime values, persistence stays behind `@repo/database`, auth/tenant denial is tested through middleware, and API tests/gates pass.

## Common mistakes

- Forgetting the module router or root router registration.
- Returning a shape not covered by `.output(...)`.
- Accepting `userId` from input instead of using authenticated context.
- Using `/api` in `.route({ path })`; Hono applies the `/api` base path.
- Passing a fake user directly to `call` and bypassing protected-procedure middleware.
- Duplicating a reusable input schema in the app instead of exporting it from the API module.
