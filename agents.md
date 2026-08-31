# AGENTS.md

This file applies to the whole `supastarter-nextjs` repository.
Mirror existing conventions and prefer nearby canonical implementations.
Explicit user instructions win; if a documented command fails, report it rather than inventing a workaround.

## Stack

- Next.js App Router, React, TypeScript, Node.js 22+, and pnpm workspaces
- Turborepo, oRPC, Hono, Better Auth, Prisma, and Drizzle
- Tailwind CSS, Shadcn-style components, and Base UI (`@base-ui/react`)
- React Hook Form, Zod 4, TanStack Query, next-intl, Vitest, Playwright, Oxlint, and Oxfmt

## Setup & verification

### Environment

Copy `.env.local.example` to `.env.local`. For local boot, set `DATABASE_URL` to
`postgresql://postgres:postgres@localhost:5432/supastarter`, set `BETTER_AUTH_SECRET`,
and keep the local app URLs from the example. OAuth, mail, payments, storage, and AI
variables are only needed when using those integrations.

Start the local services with:

```bash
docker compose up -d postgres
```

The `postgres` service is PostgreSQL 16 on port 5432. The compose file also defines
MinIO (`minio` and `minio-setup`) for S3-compatible storage when storage features are used.

### Install and run

```bash
pnpm install
pnpm dev
```

`pnpm dev` runs the active workspace development tasks through Turbo and excludes the retained
legacy `marketing` application. The public landing and authenticated product both run in `saas`.

### Root commands

| Command                             | Purpose                        |
| ----------------------------------- | ------------------------------ |
| `pnpm dev`                          | Start development tasks        |
| `pnpm build`                        | Build the workspace            |
| `pnpm start`                        | Start built applications       |
| `pnpm lint` / `pnpm lint:fix`       | Check / fix Oxlint issues      |
| `pnpm format` / `pnpm format:check` | Write / check Oxfmt formatting |
| `pnpm type-check`                   | Run workspace type checks      |
| `pnpm test`                         | Run Vitest workspace tests     |
| `pnpm clean`                        | Clear Turbo outputs            |

Validation is impact-based:

1. For small, low-risk changes, format, lint, type-check, and test only the changed files or the
   directly affected workspace. Do not run root `pnpm test`, unrelated E2E suites, or a full build.
2. Run full-workspace checks only for cross-workspace changes, high-risk behavior (auth, payments,
   database, security, concurrency, or production infrastructure), release certification, explicit
   CI parity, or when the user asks for them.
3. If no focused test exists, run the nearest package-level check and report that limitation instead
   of expanding automatically to the whole repository.

The root test task runs Vitest in `apps/marketing`, `apps/saas`, and `packages/api` while legacy
compatibility code remains. The active product Playwright tests are in `apps/saas/tests`; use
`pnpm --filter saas e2e` or `pnpm --filter saas e2e:ci`. The media E2E harness starts only SaaS and
requires a running database.

## Monorepo map

```text
apps/
├── docs/          # Next.js/Fumadocs documentation
├── mail-preview/  # Email preview
├── marketing/     # Retained legacy public/blog implementation; not a root runtime service
└── saas/          # Unified public landing, guest trial, and authenticated product
packages/
├── ai/
├── api/
├── auth/
├── database/
├── i18n/
├── logs/
├── mail/
├── notifications/
├── payments/
├── storage/
├── ui/
└── utils/
tooling/
├── scripts/
├── tailwind/
└── typescript/
```

## Imports & path aliases

`@repo/*` and `@repo/ui/*` are pnpm workspace package names. They are not
TypeScript, Vite, or Next path mappings. Use package exports such as
`@repo/auth`, `@repo/database`, and `@repo/ui/components/button`.

Only app-local aliases are configured in the app `tsconfig.json` files.

### `apps/saas/tsconfig.json`

| Alias              | Target                      |
| ------------------ | --------------------------- |
| `@config`          | `./config`                  |
| `@auth/*`          | `./modules/auth/*`          |
| `@organizations/*` | `./modules/organizations/*` |
| `@settings/*`      | `./modules/settings/*`      |
| `@payments/*`      | `./modules/payments/*`      |
| `@i18n/*`          | `./modules/i18n/*`          |
| `@admin/*`         | `./modules/admin/*`         |
| `@ai/*`            | `./modules/ai/*`            |
| `@onboarding/*`    | `./modules/onboarding/*`    |
| `@shared/*`        | `./modules/shared/*`        |

### `apps/marketing/tsconfig.json`

| Alias                 | Target                             |
| --------------------- | ---------------------------------- |
| `@config`             | `./config`                         |
| `@analytics`          | `./modules/analytics`              |
| `@home/*`             | `./modules/home/*`                 |
| `@blog/*`             | `./modules/blog/*`                 |
| `@i18n/*`             | `./modules/i18n/*`                 |
| `@changelog/*`        | `./modules/changelog/*`            |
| `@legal/*`            | `./modules/legal/*`                |
| `@shared/*`           | `./modules/shared/*`               |
| `content-collections` | `./.content-collections/generated` |

## API & data layer

oRPC modules live under `packages/api/modules`. Procedures use `publicProcedure`,
`protectedProcedure`, or `adminProcedure`, with route metadata, Zod input validation,
middleware, and a handler. Follow `packages/api/modules/organizations/procedures/`.

Keep database access in `packages/database`. Prisma owns the schema and migrations;
Drizzle is used for query implementations. The database package scripts are:

```bash
pnpm --filter @repo/database generate
pnpm --filter @repo/database push
pnpm --filter @repo/database migrate
pnpm --filter @repo/database studio
```

Edit `packages/database/prisma/schema.prisma` for Prisma schema changes, then use
the appropriate database command. Do not hand-edit generated Prisma client output
or `packages/database/prisma/zod/index.ts`.

### Notifications

Create server-side notifications with `createNotification` from
`packages/notifications/src/create-notification.ts`. Types and kinds live in
`packages/notifications/src/types.ts`, and the settings catalog lives in
`packages/notifications/src/catalog.ts`; keep the database enum, catalog, and i18n labels in sync.

For client data fetching, use the oRPC helpers in
`apps/saas/modules/shared/lib/orpc-query-utils.ts` with TanStack Query.

## Framework patterns

- Use Server Components by default; add `"use client"` only for browser APIs or interaction.
- Keep client boundaries small and keep server-only data access on the server.
- Follow the auth/layout patterns in `apps/saas/app/(authenticated)/layout.tsx`.
- Follow the oRPC procedure pattern in `packages/api/modules/organizations/procedures/`.

## Auth & multi-tenancy

- Server sessions use `getSession` from `@auth/lib/server`.
- Client session state uses `useSession` from `@auth/hooks/use-session`.
- Scope organization data with the active organization helpers under
  `apps/saas/modules/organizations`.
- When changing auth flows, update relevant templates under `packages/mail/emails`,
  preserve audit hooks, and verify locale handling.

Canonical auth examples:
`apps/saas/modules/auth/components/LoginForm.tsx` and
`apps/saas/modules/auth/lib/server.ts`.

## UI, forms, and i18n

- Use components from `@repo/ui/components`; Base UI primitives are wrapped there.
  Compose with the `render` prop (Base UI); there is no Radix `asChild`.
- Use React Hook Form with Zod. Follow
  `apps/marketing/modules/home/components/ContactForm.tsx`.
- Use `next-intl` `useTranslations()` in client components and the server helpers
  from `next-intl/server`. Follow `apps/saas/modules/i18n/request.ts`.
- Locale configuration and cookie name are in `packages/i18n/config.ts`.

## Config & environment variables

Keep server-only variables unprefixed. Browser-visible variables use `NEXT_PUBLIC_`.
Use `.env.local` for local secrets and never commit it. App runtime configuration
and aliases belong in the relevant app config/tsconfig rather than a package.

### AI media foundation invariants

- Treat PostgreSQL as the only business source of truth. Trigger.dev, Stripe,
  browsers, storage, moderation, and AI providers deliver work or events but do
  not own domain state.
- Create a generation job, bind inputs, reserve credits, and write its initial
  Outbox event in one transaction. Keep later credit mutations immutable,
  idempotent, and tied to stable reference keys.
- Submit only stable public product keys from clients. Provider routes, model
  IDs, credentials, prices, raw payloads, and arbitrary remote URLs stay server-only.
- Keep inputs and outputs as private `MediaAsset` records. Enforce byte,
  multipart, session, and aggregate storage limits before writes, and stream
  large transfers instead of buffering them in application memory.
- If provider acceptance is uncertain, keep credits reserved and prohibit
  cancellation or automatic failover until recovery or an audited administrator
  decision settles the same attempt.
- Enforce `MEDIA_GENERATION_ENABLED` during generation authorization. Production
  must reject the legacy unmetered AI stream and all mock/test adapters.
- Verify and persist raw Stripe webhook events with Outbox first. Workers own
  subscription, billing-period, ledger, cancellation, refund, and debt changes.
  Organization billing actions require owner authorization.
- Do not describe local mocks, MinIO/PostgreSQL, dry-run smoke tests, or local
  Trigger checks as live external verification.

## Dependencies & supply chain

`pnpm-workspace.yaml` sets `minimumReleaseAge: 1440`; installing a release younger
than 24 hours can fail. Use existing `catalog:` versions where available and add
dependencies to the workspace package that imports them.

## Change management

- Use conventional commits such as `feat:`, `fix:`, `docs:`, or `refactor:`.
- Update `CHANGELOG.md` for consumer-impacting changes.
- Update `apps/saas/modules/landing`, shared translations, and relevant product docs for public
  landing behavior. Update legacy `apps/marketing/content` only when that retained content changes.
- Update `AGENTS.md` when conventions, aliases, scripts, or app boundaries change.
- Supastarter ships three starter kits. Keep changes generic and consider whether
  an equivalent update belongs in the Nuxt or TanStack Start kit.

## Before you're done

- [ ] Formatting and linting pass for the affected files or workspace
- [ ] Type checking passes for the affected workspace when TypeScript changed
- [ ] Directly affected tests pass; full-workspace tests run only when the impact policy requires them
- [ ] No `console.log` statements were added
- [ ] No unjustified `any` types were added
- [ ] User-facing strings have translations
- [ ] Relevant docs and `CHANGELOG.md` are updated

More documentation: https://supastarter.dev/docs/nextjs
