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
- Create job, input bindings, credit reservation, and durable execution intent in one transaction: legacy uses its initial Outbox event; video uses `VideoExecution` start intent. Later ledger mutations remain immutable and idempotent with stable reference keys.
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

Resources groups Blog, Editing Examples and Docs. Photo Ideas are Blog articles with optional validated shared generation presets; the Blog owns their canonical/publication identity. Legacy `/effects` routes only redirect to published Blog destinations. Keep recipe evidence, draft isolation and safe editor-return validation when adding or migrating a Photo Idea; do not introduce a parallel public Effects catalog.

The Playwright `public` project skips database auth setup. Run SaaS Vitest, Next/Fumadocs generation, and browser checks sequentially because they share generated `.source`.

## Cloudflare execution and hosting

Default `workers` uses OpenNext for the site and Workflows/WorkerJobs for jobs; `hybrid` changes background execution to the private Node container only. `dispatchJob` from `@repo/jobs/orchestration/client` is the API submission path. Business transitions stay in `packages/jobs` and `packages/database`; preserve PostgreSQL leases, immutable ledger, Outbox recovery, and uncertainty gates. Never fail over runtimes automatically after uncertain/timed-out execution.

Video uses the separate native `VIDEO_WORKFLOW` binding and versioned `VideoGenerationWorkflowV1` in both profiles. Its normal execution must not dispatch `jobs-primary` or scan global Outbox. Preserve `executionEngine` / `verificationEngine` guards in legacy callbacks, recovery, moderation, administration and settlement. Ordinary video uses `VIDEO_V1_ACCESS=authenticated` for all signed-in, non-anonymous accounts, with qualifying paid credits, readiness and implemented Kie model contracts still required. There is no user-ID or model-option test allowlist; legacy `VIDEO_V1_ALLOWED_USER_IDS` and `VIDEO_MODEL_ALLOWED_OPTIONS` are ignored and removed from newly packed policy. Missing access settings retain administrator-only internal rollback access and invalid settings deny admission. Ordinary `VIDEO_PRICE_VALID_UNTIL=none` explicitly removes a fixed price-approval deadline, while ten-minute quotes and previously accepted finite deadlines remain unchanged. Unsupported or unpriced Kie options stay unavailable. This policy does not authorize administrator funding for authenticated customer requests. Hotel Lobby and Raindance keep independent audience, complete-cost and finite approval settings; opening ordinary video must not widen internal template access. Keep template history owner-scoped and readable when generation closes. Model properties and full-cost quotes come from the versioned server contract; qualify paid credit lots before allocation. Refund monetary projections take the account lock even when rounded revoked credits do not increase. Prompt review uses Waffo and visual review uses SeeAPI against immutable content; Sightengine is retired. Native model sound remains supported, but new requests freeze `audioSafetyPolicy.mode=not_requested` without transcription or audio-review calls. Historical tasks requiring audio review remain held without rewriting their policy. See `docs/operations/video-authenticated-rollout-2026-10-07.md`, `docs/operations/video-v1-rollout.md` and `docs/operations/hotel-lobby-public-rollout.md` for drain and rollback.

Workers route heavy transfers and synchronous image responses to `jobs-primary` (1), lightweight control work to `jobs-control` (4), and maintenance to `jobs-maintenance` (1). Keep classification in `packages/jobs/src/orchestration/worker-executors.ts`; inline Outbox children must stay within the parent's maintenance slot. Separate Durable Objects do not guarantee separate memory isolates.

Normal first-image continuation uses committed event IDs through `media-deliver-events`, with accepted attempts polling in their existing Workflow. Explicit empty continuation suppresses global scanning; legacy responses and scheduled recovery retain it. Targeted and scanned delivery share leases, due times and completion receipts. Ordinary untransformed images up to 10 MiB use one conditional private write; guest transformations, unknown/large transfers and persisted multipart recovery retain staging. See `docs/operations/first-image-scanless-batch-2026-09-30.md` for local test boundaries and receiver-first rollout/drain order.

The legacy `media-deliver-output-review` entry remains accepted on control for existing 2A-1 Workflows. New output PENDING results use the generic continuation after heavy execution releases its slot. Acceptance alone never ACKs the event; keep the stored next-query time and provider task identity.

For jobs, database runtime imports, packaging, or deployment, use [Cloudflare runtime constraints](docs/agent-reference/cloudflare-runtime.md) and [profile cutover/drain/rollback operations](docs/operations/cloudflare-workers-profiles.md). Builds/preparation do not deploy or certify live cron, recovery, shutdown, or external integrations.

Consumer-facing changes update `CHANGELOG.md`, relevant `apps/saas/modules/landing`, `apps/saas/content`, product docs, and translations. Use conventional commits and update this entry when app/runtime boundaries change.

Raindance is an indexable Blog prompt guide with an embedded paid Solo/Duet beta. Its independent `RAINDANCE_ENABLED`, `RAINDANCE_ACCESS` and accepted template version use the existing two-stage video engine and approved Hotel Lobby complete-cost budget. Keep the ordinary-video and Hotel Lobby audience and funding policies independent. The generated pier illustration is editorial art, never product acceptance evidence. See `docs/operations/raindance-rollout.md`.
