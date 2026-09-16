# EzPic

`apps/saas` serves the public landing/content/docs, guest workspace, and authenticated product on one origin. `pnpm dev`, `pnpm build`, and `pnpm start` target SaaS and its dependencies. Run `apps/mail-preview` explicitly when needed.

## Setup and verification

Copy `.env.local.example` to `.env.local`; local boot uses the example app URLs, `BETTER_AUTH_SECRET`, and `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/supastarter`. Start PostgreSQL 16 with `docker compose up -d postgres`; MinIO is optional for storage work. Install with `pnpm install`.

Small, low-risk changes use format/lint/type/test checks for affected files or workspaces only. Full-workspace validation is for cross-workspace or high-risk behavior, release certification, CI parity, or an explicit request. If no focused test exists, use the nearest package check and state its limit. Do not automatically expand to root tests, unrelated E2E, or a full build.

Root checks: `pnpm format`, `pnpm format:check`, `pnpm lint`, `pnpm type-check`, `pnpm test`, `pnpm build`. Active Playwright tests live in `apps/saas/tests`: `pnpm --filter saas e2e` / `e2e:ci`; media E2E starts only SaaS and requires a running database. `pnpm cache:preview` previews scoped build-cache cleanup; `pnpm cache:clean` performs its scope/lock checks. `pnpm clean` also removes dependencies.

## Repository conventions

- Node.js 22+, pnpm/Turbo, Next.js App Router, oRPC/Hono, Better Auth, Prisma/Drizzle, Base UI, next-intl, Oxlint/Oxfmt.
- `@repo/*` names are workspace package exports, not TS/Next/Vite path aliases. App-local aliases are defined by each app's `tsconfig.json`.
- Database access stays in `packages/database`; Prisma owns schema/migrations and Drizzle implements queries. Edit `packages/database/prisma/schema.prisma`; never edit generated Prisma clients or `prisma/zod/index.ts`. Use `pnpm --filter @repo/database <script>` with `generate`, `push`, `migrate`, or `studio`; choose the intended operation and database.
- oRPC procedures belong in `packages/api/modules`, using the appropriate public/protected/admin procedure, Zod input, and middleware. Follow the organizations procedures. SaaS clients use `modules/shared/lib/orpc-query-utils.ts` with TanStack Query.
- Auth uses `getSession` / `useSession` from the existing auth module; scope tenant data through active-organization helpers. Auth changes preserve audit hooks, locale behavior, and relevant mail templates.
- UI uses `@repo/ui/components` and Base UI's `render` prop, not Radix `asChild`. Reuse React Hook Form + Zod and `next-intl`; locale/cookie configuration is in `packages/i18n/config.ts`.
- Notifications use `packages/notifications/src/create-notification.ts`; keep the DB enum, types/catalog, and i18n labels aligned.
- Keep secrets in ignored `.env.local`, server variables unprefixed, and browser variables `NEXT_PUBLIC_`. Do not move server data access into client components.
- Keep `pnpm-workspace.yaml`'s `minimumReleaseAge: 1440`; prefer `catalog:` versions and add dependencies to the importing package.

## AI media invariants

- PostgreSQL alone owns business state; orchestration, Stripe, providers, storage, moderation, and browsers deliver work/events.
- Create job, input bindings, credit reservation, and initial Outbox event in one transaction. Later ledger mutations remain immutable and idempotent with stable reference keys.
- Clients submit stable public product keys only. Provider routes/model IDs/credentials/prices/raw payloads and arbitrary remote URLs remain server-only.
- Inputs and outputs remain private `MediaAsset` records. Enforce byte, multipart, session, and aggregate storage limits before writes; stream large transfers.
- Uncertain provider acceptance keeps credits reserved and prevents cancellation or automatic failover until recovery or an audited administrator decision settles the same attempt.
- Enforce `MEDIA_GENERATION_ENABLED` during authorization; production rejects legacy unmetered streaming and mock/test adapters.
- Verify and persist raw Stripe webhook events with Outbox first. Workers own subscriptions, periods, ledger, cancellations, refunds, and debt. Organization billing actions require owner authorization.
- Local mocks, local services, dry runs, and local orchestration builds are not evidence of live external integration.

## Public routing

The homepage owns `ai image editor no restrictions`, with `ai image editor with prompt no restrictions`
as the secondary query and `ai image editor with prompt` as the broader topic. Preserve this keyword
focus during feature work unless the user explicitly changes it. Explain "No Restrictions" as flexible
prompt editing; normal content safety, legal, model and usage limits remain applicable.

Public SEO URLs are unprefixed English routes. `apps/saas/proxy.ts` keeps bare public URLs in English; explicit `?lang=de|es|fr` interface views use `noindex, follow` and retain English canonical URLs. Account routes keep the locale cookie. New public HTML routes belong in its matcher. Reviewed published Blog posts and Docs marked `indexable: true` enter the sitemap. Changelog, Contact, and Docs API/Markdown/image artifacts stay noindex. Public unknown paths use root 404; single-segment organization URLs stay protected.

The Playwright `public` project skips database auth setup. Run SaaS Vitest, Next/Fumadocs generation, and browser checks sequentially because they share generated `.source`.

## Cloudflare execution and hosting

Default `workers` uses OpenNext for the site and Workflows/WorkerJobs for jobs; `hybrid` changes background execution to the private Node container only. `dispatchJob` from `@repo/jobs/orchestration/client` is the API submission path. Business transitions stay in `packages/jobs` and `packages/database`; preserve PostgreSQL leases, immutable ledger, Outbox recovery, and uncertainty gates. Never fail over runtimes automatically after uncertain/timed-out execution.

For jobs, database runtime imports, packaging, or deployment, use [Cloudflare runtime constraints](docs/agent-reference/cloudflare-runtime.md) and [profile cutover/drain/rollback operations](docs/operations/cloudflare-workers-profiles.md). Builds/preparation do not deploy or certify live cron, recovery, shutdown, or external integrations.

Consumer-facing changes update `CHANGELOG.md`, relevant `apps/saas/modules/landing`, `apps/saas/content`, product docs, and translations. Use conventional commits and update this entry when app/runtime boundaries change.
