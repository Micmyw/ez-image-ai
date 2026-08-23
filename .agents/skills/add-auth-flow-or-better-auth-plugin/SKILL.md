---
name: add-auth-flow-or-better-auth-plugin
description: Use when adding an authentication journey, Better Auth server plugin, or matching client capability.
---

# Add an auth flow or Better Auth plugin

## Scope

Use for sign-in, sign-up, verification, account security, OAuth, or Better Auth extensions. Do not implement session or password handling outside Better Auth.

## Procedure

1. Read `packages/auth/auth.ts`, `packages/auth/client.ts`, `packages/auth/config.ts`, and the plugin's current Better Auth API before changing the flow.
2. Configure the server plugin in the `plugins` array of `packages/auth/auth.ts`. Configure its matching client plugin in `packages/auth/client.ts` when browser calls are required.
3. Add required persisted fields to `packages/database/prisma/schema.prisma` and semantically mirror all PostgreSQL/MySQL/SQLite Drizzle schemas, then run:
   ```bash
   pnpm --filter @repo/database generate
   pnpm --filter @repo/database migrate
   ```
4. Expose user-configurable behavior through typed flags in `packages/auth/types.ts` and `packages/auth/config.ts`; make UI honor those flags.
5. Add/update the smallest route/components under `apps/saas/app/(unauthenticated)` or `apps/saas/modules/auth`. Use `authClient` from `@repo/auth/client` in client components and `getSession` from `@auth/lib/server` in Server Components.
6. Preserve locale-aware mail callbacks and subscription/organization hooks in `packages/auth/auth.ts`. Add templates/translations when the flow sends email.
7. Route through the existing Hono auth mount: `packages/api/index.ts` handles `/api/auth/**`, and `apps/saas/app/api/[[...rest]]/route.ts` exposes it. Do not add another catch-all.
8. Add unit coverage and update `apps/saas/tests/login.spec.ts` or another Playwright spec for user-visible flow changes.
9. Run relevant tests, `pnpm format`, `pnpm lint`, and `pnpm type-check`.

## Canonical reference

Passkeys and two-factor auth pair server plugins in `packages/auth/auth.ts` with `passkeyClient()` and `twoFactorClient()` in `packages/auth/client.ts`; `apps/saas/modules/auth/components/LoginForm.tsx` gates their UI through config.

## Done

Server/client plugin capabilities match, all schema variants and generated output align, the existing Hono mount serves the flow, locale-aware mail and lifecycle hooks remain intact, config flags/translations control UI, and auth denial/success E2E plus gates pass.

## Common mistakes

- Registering only the client or server half of a plugin.
- Adding a separate Next.js `/api/auth` handler.
- Trusting client session state for server authorization.
- Dropping invitation, locale, or subscription cleanup hooks while restructuring auth.
- Updating Prisma for a plugin while leaving one of the three Drizzle starter schemas stale.
