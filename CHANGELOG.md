# Changelog

## 2026-08-14

### Added

#### AI media foundation

- Added a reusable image/video creator, generation history and detail views, private asset library, and one-time anonymous marketing draft handoff.
- Added a server-only product catalog and Provider adapters for Replicate, Fal, Kie, and Gemini, with normalized submission, status, result, error, Webhook, and reconciliation contracts.
- Added Trigger.dev task bindings backed by PostgreSQL jobs, attempts, persisted events, transactional Outbox delivery, reconciliation, finalization, moderation, settlement, and cleanup handlers.
- Added immutable credit lots and ledger entries, atomic reservations and settlement, Stripe subscription billing periods, annual-plan monthly grants, cancellation, refunds, and refund debt.
- Added private single/multipart uploads, signed reads, streamed Provider output transfer, aggregate storage and active-upload quotas, quarantine, soft deletion, and durable object cleanup.
- Added redacted structured logging, Sentry integration points, protected media operations, runtime model controls, Provider smoke budgets, load profiles, invariant verification, and an operator runbook.

### Security

- Fail closed when generation is disabled, reject the legacy unmetered AI stream in production, restrict organization billing and deletion to owners, and allow checkout redirects only to the configured SaaS origin.
- Freeze reservations for uncertain Provider submissions until bounded recovery or an audited administrator decision; confirmed rejection is idempotent, releases the reservation, and charges zero.
- Moderate prompts before quote creation, persist immutable prompt-free approval evidence and a full quote fingerprint, and reject legacy, stale, or tampered moderation evidence before dispatch.
- Restrict authenticated Provider polling URLs and output hosts, preserve terminal Provider/Stripe event ordering, enforce raw-body Webhook verification, and keep media storage origins and buckets private.
- Enforce multipart reservation boundaries, per-owner storage/session quotas, deterministic cleanup, request limits, exact origins, security headers, log redaction, and server-only secrets.
- Updated production dependencies so `pnpm audit --prod --audit-level high` reports no high or critical advisories.

### Testing

- Added isolated PostgreSQL migration, drift, integration, ledger and invariant gates; Provider/moderation contracts; Trigger task checks; SaaS and marketing production builds; dependency and secret scans; and separate Playwright artifacts in PR CI.
- Added 11 deterministic production-build browser scenarios with no skips: nine authenticated SaaS generation/storage/credit workflows and two marketing draft-handoff workflows. They prove the local application path with test adapters, not live Provider, Trigger.dev cloud, Stripe, Sightengine, S3/R2, or Sentry connectivity.
- Fresh isolated PostgreSQL verification applies all 16 migrations with zero drift and passes unit/contracts, database/jobs/API/auth integrations, and all nine invariant checks. Workspace type checks, both webpack production builds, and the guarded local route smoke pass; real k6 and target-duration load remain staging acceptance activities.

## 2026-08-04

### Added

#### Admin

- **User bans**: Added admin controls to ban users with an internal reason and optional expiration, review active ban details, and unban users.

### Changed

#### Dependencies

- **Production dependencies**: Bumped `@hookform/resolvers` to `^5.7.1`, `hono` to `^4.12.34`, and `react-dropzone` to `^20.0.0` (major upgrade: Node.js 22+ required, ESM-first package layout). Synced the lockfile for `fumadocs-mdx` `15.2.2`. Skipped `typescript` `7.x` (Next.js 16.2.x still probes `typescript/lib/typescript.js`, which TypeScript 7 no longer ships) and `@types/uuid` (deprecated). Refresh the lockfile with `pnpm install` after pulling. `pnpm-workspace.yaml` enforces `minimumReleaseAge: 1440` (one day) at install time.
- **Development dependencies**: Bumped `tsx` to `^4.23.5`.

---

## 2026-08-03

### Fixed

#### Auth

- **Login tab order**: Repositioned the forgot-password link so keyboard navigation moves from the password field to the password visibility toggle before leaving the field group.

#### UI

- **Base UI migration follow-ups**: Repaired button `render` composition, dropdown link grouping, select popup sizing, and destructive confirmation styling after the Base UI migration.

### Changed

#### Dependencies

- **Production dependencies**: Bumped `ai` to `^7.0.48`, `@ai-sdk/react` to `^4.0.51`, `@hookform/resolvers` to `^5.6.0`, and `react-dropzone` to `^19.2.0`. Synced the lockfile to the catalog (including prior bumps for `ai` `^7.0.47`, `@ai-sdk/openai` `^4.0.27`, `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` `3.1101.0`, `dodopayments` `^2.44.0`, `hono` `^4.12.33`, `nuqs` `^2.9.4`, and `react-hook-form` `^7.84.0`). Skipped `typescript` `7.x` (Next.js 16.2.x still probes `typescript/lib/typescript.js`, which TypeScript 7 no longer ships) and `@types/uuid` (deprecated). Refresh the lockfile with `pnpm install` after pulling. `pnpm-workspace.yaml` enforces `minimumReleaseAge: 1440` (one day) at install time.
- **Development dependencies**: Bumped `start-server-and-test` to `^3.0.12`. Synced the lockfile (including prior bumps for `@shikijs/rehype` `^4.4.1`, `prisma-zod-generator` `3.1.0`, and `turbo` `^2.10.8`).

---

## 2026-08-02

### Changed

#### Dependencies

- **Production dependencies**: Bumped `ai` to `^7.0.47`, `@ai-sdk/openai` to `^4.0.27`, `@ai-sdk/react` to `^4.0.50`, `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` to `3.1101.0`, `dodopayments` to `^2.44.0`, `hono` to `^4.12.33`, `nuqs` to `^2.9.4`, and `react-hook-form` to `^7.84.0`. Skipped `typescript` `7.x` (Next.js 16.2.x still probes `typescript/lib/typescript.js`, which TypeScript 7 no longer ships) and `@types/uuid` (deprecated). Refresh the lockfile with `pnpm install` after pulling. `pnpm-workspace.yaml` enforces `minimumReleaseAge: 1440` (one day) at install time.
- **Development dependencies**: Bumped `@shikijs/rehype` to `^4.4.1`, `prisma-zod-generator` to `3.1.0`, and `turbo` to `^2.10.8`.

---

## 2026-07-31

### Fixed

- **Auth redirects**: Restricted login, signup, OTP, and onboarding redirects to normalized root-relative SaaS paths, preventing untrusted `redirectTo` values from navigating users to external sites.
- **SaaS indexing**: Added app-wide `noindex, nofollow` robots metadata so authentication and protected SaaS pages are not included in search results.

### Changed

#### Headless UI library: Radix UI → Base UI

- **Breaking**: `packages/ui` now builds on `@base-ui/react` instead of `radix-ui`, matching the TanStack Start version. Composition uses Base UI's `render` prop; the Radix `asChild` prop has been removed from all components (no compatibility shim).
  - `<Button asChild><Link href="/" /></Button>` becomes `<Button render={(props) => <Link {...props} href="/" />} />`.
  - `<DropdownMenuTrigger asChild><Button /></DropdownMenuTrigger>` becomes `<DropdownMenuTrigger render={<Button />} />`.
  - `DropdownMenuItem` rendering a link needs `nativeButton={false}` alongside `render`.
- **State attributes**: Radix `data-[state=open|closed|checked]` variants are replaced by Base UI `data-[open]`, `data-[closed]`, `data-[checked]`, `data-[starting-style]`, and `data-[ending-style]`. Custom styles targeting the old attributes must be updated.
- **CSS variables**: `--radix-accordion-content-height` → `--collapsible-panel-height`, `--radix-dropdown-menu-trigger-width` → `--anchor-width`.
- **Component API deltas**: `Tabs` uses `Tab`/`Panel` instead of `Trigger`/`Content`, `Accordion` takes `multiple`/`defaultValue` instead of `type`/`collapsible`, `TooltipProvider` takes `delay` instead of `delayDuration`, `DropdownMenuItem` uses `closeOnClick={false}` instead of `onSelect` + `preventDefault`, and `Select` accepts an `items` prop so `SelectValue` renders labels instead of raw values.
- **Dependencies**: Removed `radix-ui`, added `@base-ui/react` to the workspace catalog and `@repo/ui`.

#### Dependencies

- **Production dependencies**: Bumped `ai` to `^7.0.42`, `@ai-sdk/openai` to `^4.0.24`, `@ai-sdk/react` to `^4.0.45`, `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` to `3.1098.0`, `nuqs` to `^2.9.3`, `postcss` to `8.5.25`, and `stripe` to `^22.4.0`. Skipped `typescript` `7.x` (Next.js 16.2.x still probes `typescript/lib/typescript.js`, which TypeScript 7 no longer ships) and `@types/uuid` (deprecated). Refresh the lockfile with `pnpm install` after pulling. `pnpm-workspace.yaml` enforces `minimumReleaseAge: 1440` (one day) at install time.

---

## 2026-07-30

### Changed

#### Dependencies

- **Production dependencies**: Bumped `ai` to `^7.0.41`, `@ai-sdk/openai` to `^4.0.23`, `@ai-sdk/react` to `^4.0.44`, `@orpc/client`, `@orpc/json-schema`, `@orpc/openapi`, `@orpc/server`, `@orpc/tanstack-query`, and `@orpc/zod` to `1.14.13`, `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` to `3.1097.0`, and `postcss` to `8.5.24`. Synced the lockfile to the catalog (including prior bumps for `@prisma/adapter-pg`, `@prisma/client`, `@prisma/nextjs-monorepo-workaround-plugin`, and `prisma` `7.9.1`, and `fumadocs-core` / `fumadocs-ui` `16.13.0`). Skipped `typescript` `7.x` (Next.js 16.2.x still probes `typescript/lib/typescript.js`, which TypeScript 7 no longer ships) and `@types/uuid` (deprecated). Refresh the lockfile with `pnpm install` after pulling. `pnpm-workspace.yaml` enforces `minimumReleaseAge: 1440` (one day) at install time.
- **Development dependencies**: Bumped `resend` to `^6.18.1` in `@repo/mail`.

---

## 2026-07-29

### Changed

#### Dependencies

- **Production dependencies**: Bumped `ai` to `^7.0.40`, `@ai-sdk/openai` to `^4.0.22`, `@ai-sdk/react` to `^4.0.43`, `@orpc/client`, `@orpc/json-schema`, `@orpc/openapi`, `@orpc/server`, `@orpc/tanstack-query`, and `@orpc/zod` to `1.14.12`, `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` to `3.1096.0`, `@prisma/adapter-pg`, `@prisma/client`, `@prisma/nextjs-monorepo-workaround-plugin`, and `prisma` to `7.9.1`, and `fumadocs-core` / `fumadocs-ui` to `16.13.0`. Skipped `typescript` `7.x` (Next.js 16.2.x still probes `typescript/lib/typescript.js`, which TypeScript 7 no longer ships) and `@types/uuid` (deprecated). Refresh the lockfile with `pnpm install` after pulling. `pnpm-workspace.yaml` enforces `minimumReleaseAge: 1440` (one day) at install time.
- **Development dependencies**: Bumped `@types/node` to `26.1.2`, `oxlint` to `^1.76.0`, and `oxfmt` to `^0.61.0`.

---

## 2026-07-28

### Changed

#### Dependencies

- **Production dependencies**: Bumped `@orpc/client`, `@orpc/json-schema`, `@orpc/openapi`, `@orpc/server`, `@orpc/tanstack-query`, and `@orpc/zod` to `1.14.10`, and `@hookform/resolvers` to `^5.5.7`. Upgraded `prisma-zod-generator` to `3.0.1` (major) and regenerated Prisma Zod schemas. Skipped `typescript` `7.x` (Next.js 16.2.x still probes `typescript/lib/typescript.js`, which TypeScript 7 no longer ships) and `@types/uuid` (deprecated). Refresh the lockfile with `pnpm install` after pulling. `pnpm-workspace.yaml` enforces `minimumReleaseAge: 1440` (one day) at install time.
- **Development dependencies**: Bumped `turbo` to `^2.10.7`.

---

## 2026-07-27

### Fixed

#### API

- **Organization billing authorization**: Require organization membership when listing purchases and an owner or administrator role when creating organization checkout sessions. Inaccessible customer portal purchases now return `NOT_FOUND` to prevent resource enumeration.
- **Payment redirects**: Restrict checkout and customer portal return URLs to the configured SaaS application origin.
- **AI message validation**: Validate incoming UI messages with the AI SDK before converting them or invoking the model.

### Changed

#### API

- **Response contracts**: Added explicit, co-located Zod output schemas to every oRPC procedure and removed redundant notification response remapping.

#### SaaS app

- **Organization role select**: Removed secondary role descriptions from the organization role select and the unused translation keys so the selector shows only compact role names.

#### Dependencies

- **Production dependencies**: Bumped `@ai-sdk/anthropic` to `^4.0.21`, `next` to `^16.2.12`, `@next/third-parties` to `16.2.12`, `lucide-react` to `^1.27.0`, `radix-ui` to `^1.6.7`, and `recharts` to `^3.10.1`. Synced the lockfile to the catalog (including prior bumps for `ai` `^7.0.37`, `@ai-sdk/openai` `^4.0.20`, `@ai-sdk/react` `^4.0.40`, `@aws-sdk/client-s3` / `@aws-sdk/s3-request-presigner` `3.1095.0`, `better-auth` `1.6.25`, `hono` `^4.12.32`, `next-intl` `4.13.4`, `fumadocs-core` / `fumadocs-ui` `16.12.1`, and related catalog entries). Skipped `typescript` `7.x` (Next.js 16.2.x still probes `typescript/lib/typescript.js`, which TypeScript 7 no longer ships), `@types/uuid` (deprecated), `@orpc/*` `1.14.10`, `@hookform/resolvers` `5.5.3`, `prisma-zod-generator` `2.8.1`, and `turbo` `2.10.7` (published within the one-day `minimumReleaseAge` window). Refresh the lockfile with `pnpm install` after pulling. `pnpm-workspace.yaml` enforces `minimumReleaseAge: 1440` (one day) at install time.

---

## 2026-07-26

### Changed

#### Dependencies

- **Production dependencies**: Bumped `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` to `3.1095.0`, `hono` to `^4.12.32`, `@ai-sdk/anthropic` to `^4.0.20`, `dodopayments` to `^2.43.0`, `es-toolkit` to `^1.50.0`, `react-hook-form` to `^7.83.0`, and `nuqs` to `^2.9.2`. Synced the lockfile to the catalog (including prior bumps for `ai` `^7.0.37`, `@ai-sdk/openai` `^4.0.20`, `@ai-sdk/react` `^4.0.40`, `better-auth` `1.6.25`, `lucide-react` `^1.26.0`, `next-intl` `4.13.4`, `fumadocs-core` / `fumadocs-ui` `16.12.1`, and `react-email` `^6.9.1`). Skipped `typescript` `7.x` (Next.js 16.2.x still probes `typescript/lib/typescript.js`, which TypeScript 7 no longer ships), `@types/uuid` (deprecated), `@ai-sdk/anthropic` `4.0.21` and `turbo` `2.10.7` (published within the one-day `minimumReleaseAge` window). Refresh the lockfile with `pnpm install` after pulling. `pnpm-workspace.yaml` enforces `minimumReleaseAge: 1440` (one day) at install time.
- **Development dependencies**: Bumped `postcss` to `8.5.23` and `@playwright/test` to `^1.62.0`.

---

## 2026-07-25

### Changed

#### Dependencies

- **Production dependencies**: Bumped `ai` to `^7.0.37`, `@ai-sdk/anthropic` to `^4.0.19`, `@ai-sdk/openai` to `^4.0.20`, `@ai-sdk/react` to `^4.0.40`, `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` to `3.1094.0`, `better-auth` to `1.6.25`, `@better-auth/passkey` to `^1.6.25`, `lucide-react` to `^1.26.0`, `next-intl` to `4.13.4`, `use-intl` to `^4.13.4`, `openai` to `^6.49.0`, `fumadocs-core` / `fumadocs-ui` to `16.12.1`, and `react-email` to `^6.9.1`. Skipped `typescript` `7.x` (Next.js 16.2.x still probes `typescript/lib/typescript.js`, which TypeScript 7 no longer ships) and `@types/uuid` (deprecated). Refresh the lockfile with `pnpm install` after pulling. `pnpm-workspace.yaml` enforces `minimumReleaseAge: 1440` (one day) at install time.
- **Development dependencies**: Synced `postcss` to `8.5.22`, `radix-ui` to `^1.6.5`, and `turbo` to `^2.10.6` in the lockfile.

---

## 2026-07-24

### Changed

#### Dependencies

- **Production dependencies**: Bumped `ai` to `^7.0.35`, `@ai-sdk/openai` to `^4.0.18`, `@ai-sdk/react` to `^4.0.38`, `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` to `3.1093.0`, `better-auth` to `1.6.24`, `@better-auth/passkey` to `^1.6.24`, `postcss` to `8.5.22`, `radix-ui` to `^1.6.5`, and `fumadocs-core` / `fumadocs-ui` to `16.12.0`. Skipped `typescript` `7.x` (Next.js 16.2.x still probes `typescript/lib/typescript.js`, which TypeScript 7 no longer ships) and `@types/uuid` (deprecated). Refresh the lockfile with `pnpm install` after pulling. `pnpm-workspace.yaml` enforces `minimumReleaseAge: 1440` (one day) at install time.
- **Development dependencies**: Bumped `turbo` to `^2.10.6`.

---

### Changed

#### Dependencies

- **Production dependencies**: Bumped `ai` to `^7.0.34`, `@ai-sdk/openai` to `^4.0.17`, `@ai-sdk/react` to `^4.0.37`, `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` to `3.1092.0`, `next` to `^16.2.11`, `@next/third-parties` to `16.2.11`, `next-intl` to `4.13.3`, `use-intl` to `^4.13.3`, `postcss` to `8.5.21`, `react` and `react-dom` to `19.2.8`, `@tanstack/react-query` to `^5.101.4`, and `resend` to `^6.18.0`. Skipped `typescript` `7.x` (Next.js 16.2.x still probes `typescript/lib/typescript.js`, which TypeScript 7 no longer ships) and `@types/uuid` (deprecated). Refresh the lockfile with `pnpm install` after pulling. `pnpm-workspace.yaml` enforces `minimumReleaseAge: 1440` (one day) at install time.
- **Development dependencies**: Bumped `oxlint` to `^1.75.0`, `oxfmt` to `^0.60.0`, and `oxlint-tsgolint` to `^7.0.2001` (major upgrade).

---

## 2026-07-22

### Changed

#### Dependencies

- **Production dependencies**: Bumped `ai` to `^7.0.32`, `@ai-sdk/react` to `^4.0.35`, `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` to `3.1091.0`, `@prisma/adapter-pg`, `@prisma/client`, and `@prisma/nextjs-monorepo-workaround-plugin` to `7.9.0`, `prisma` to `7.9.0`, `radix-ui` to `^1.6.4`, `recharts` to `^3.10.0`, `@tanstack/react-query` to `^5.101.3`, and `@polar-sh/sdk` to `^0.49.0`. Skipped `@types/uuid` (deprecated). Refresh the lockfile with `pnpm install` after pulling. `pnpm-workspace.yaml` enforces `minimumReleaseAge: 1440` (one day) at install time.
- **Development dependencies**: Reverted `typescript` to `6.0.3` because Next.js 16.2.x still probes `typescript/lib/typescript.js`, which TypeScript 7 no longer ships; this caused `next typegen` to fail in CI and left generated route types (`PageProps`, `LayoutProps`, `RouteContext`) undefined.

---

## 2026-07-21

### Changed

#### Dependencies

- **Production dependencies**: Bumped `nuqs` to `^2.9.1`, `postcss` to `8.5.20`, and `react-dropzone` to `^19.1.1`. Skipped `radix-ui` `1.6.3` (published within the one-day `minimumReleaseAge` window) and `@types/uuid` (deprecated).
- **Development dependencies**: Kept `typescript` on `6.0.3` because Next.js 16.2.x is not yet compatible with TypeScript 7's native package layout. Refresh the lockfile with `pnpm install` after pulling. `pnpm-workspace.yaml` enforces `minimumReleaseAge: 1440` (one day) at install time.

---

## 2026-07-20

### Changed

#### Dependencies

- **Production dependencies**: Bumped `hono` to `^4.12.31` and `react-dropzone` to `^19.0.2` (major upgrade: accepts in-limit files instead of rejecting the whole batch). Skipped `typescript` `7.x` (major upgrade pending ecosystem support) and `@types/uuid` (deprecated). Refresh the lockfile with `pnpm install` after pulling. `pnpm-workspace.yaml` enforces `minimumReleaseAge: 1440` (one day) at install time.

---

## 2026-07-19

### Changed

#### Dependencies

- **Production dependencies**: Bumped `ai` to `^7.0.31`, `@ai-sdk/anthropic` to `^4.0.16`, `@ai-sdk/openai` to `^4.0.16`, `@ai-sdk/react` to `^4.0.34`, `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` to `3.1090.0`, `lucide-react` to `^1.25.0`, and `react-hook-form` to `^7.82.0`. Synced the lockfile for catalog upgrades from the previous run (including `fumadocs` 16.11.5/15.2.0, `react-email` 6.9.0, `stripe` 22.3.2, and `tailwindcss` 4.3.3). Skipped `typescript` `7.x` (major upgrade pending ecosystem support) and `@types/uuid` (deprecated). Refresh the lockfile with `pnpm install` after pulling. `pnpm-workspace.yaml` enforces `minimumReleaseAge: 1440` (one day) at install time.
- **Development dependencies**: Synced `oxlint-tsgolint` to `^0.25.0`.

---

## 2026-07-18

### Changed

#### Dependencies

- **Production dependencies**: Bumped `ai` to `^7.0.30`, `@ai-sdk/openai` to `^4.0.15`, `@ai-sdk/react` to `^4.0.33`, `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` to `3.1089.0`, `fumadocs-core` and `fumadocs-ui` to `16.11.5`, `fumadocs-mdx` to `15.2.0`, `react-email` to `^6.9.0`, and `stripe` to `^22.3.2`. Skipped `typescript` `7.x` (major upgrade pending ecosystem support) and `@types/uuid` (deprecated). Refresh the lockfile with `pnpm install` after pulling. `pnpm-workspace.yaml` enforces `minimumReleaseAge: 1440` (one day) at install time.
- **Development dependencies**: Bumped `@tailwindcss/postcss` to `^4.3.3`, `tailwindcss` to `4.3.3`, and `oxlint-tsgolint` to `^0.25.0`.

---

## 2026-07-17

### Changed

#### Apps

- **Favicons**: Aligned the marketing and docs favicon assets with the updated SaaS app icon so all shipped apps use the same rocket icon.

---

## 2026-07-16

### Fixed

- **Avatar crop dialog**: Contained the Cropper.js canvas and shade inside the dialog so resizing the crop area no longer overflows the modal. The initial crop selection is 95% of the available area so drag handles stay visible by default.

### Changed

#### Theme and UI

- **Font**: Replaced Figtree with Plus Jakarta Sans in the SaaS and marketing app layouts.
- **Color tokens**: Switched the shared theme from stone to zinc neutrals, with slate primary accents in light and dark mode (`tooling/tailwind/theme.css`).
- **Buttons**: Hover states use `color-mix` for primary/secondary/destructive, and outline buttons use foreground-based borders and hover fills.
- **Dialogs and menus**: Alert dialogs use `bg-card` with larger radius; dialogs use `rounded-2xl`; dropdown menus use `rounded-xl`.
- **Logo**: Slightly smaller default logo mark (`size-8`).

#### SaaS app

- **App shell**: Removed the floating content card. Navbar and main content share the same background and are separated by a border; content padding aligns with the navbar.
- **Navbar collapse**: Replaced the header toggle with a Vercel-style edge drag strip (hover chip) to expand/collapse the sidebar. Active nav items use a muted background instead of a bordered card. Expanded mode shows the logo label.
- **Organization select**: Card-styled trigger with tighter padding; dropdown uses a regular width with the trigger as min-width, and opens to the right when the sidebar is collapsed. Plan label line-height is tightened so the trigger height stays stable. Personal account uses a user icon (instead of the profile photo), drops the group title, and shows the “Personal account” label as the row text.
- **Organization grid**: Organization logos use rounded corners to match the refreshed card styling.
- **User menu**: Dropdown uses a regular width with the trigger as min-width; opens above (expanded), to the right (collapsed desktop), or below and right-aligned (mobile).
- **Auth screens**: Removed the bordered auth card wrapper; titles and subtitles are centered. Login/signup divider labels use `bg-background`.
- **Settings**: Simplified active sessions and connected accounts rows (no bordered cards); settings item headers get consistent bottom padding on wide layouts.
- **App icon**: Updated the SaaS app icon asset.

#### Marketing

- **Hero**: Dropped the primary-tinted gradient background; hero media frame uses `bg-muted`.
- **Consent banner**: Allow action uses the primary button variant explicitly.

#### Database

- **Two-factor authentication**: Added `failedVerificationCount` and `lockedUntil` to the `TwoFactor` model in Prisma and the PostgreSQL, MySQL, and SQLite Drizzle schemas. Apply with your usual database push/migrate workflow.

#### Dependencies

- **Production dependencies**: Bumped `ai` to `^7.0.28`, `@ai-sdk/anthropic` to `^4.0.15`, `@ai-sdk/openai` to `^4.0.14`, `@ai-sdk/react` to `^4.0.30`, `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` to `3.1087.0`, and `openai` to `^6.47.0`. Synced the lockfile for catalog upgrades from previous runs (including major upgrades for `ai` 7.x, `@ai-sdk/*` 4.x, `cookie` 2.x, `cropperjs` 2.x, `nanoid` 6.x, and `react-dropzone` 17.x). Skipped `typescript` `7.x` (major upgrade pending ecosystem support) and `@types/uuid` (deprecated). Refresh the lockfile with `pnpm install` after pulling. `pnpm-workspace.yaml` enforces `minimumReleaseAge: 1440` (one day) at install time.
- **Development dependencies**: Bumped `oxlint` to `^1.74.0`, `oxfmt` to `^0.59.0`, and `turbo` to `^2.10.5`.

---

## 2026-07-15

### Fixed

- Removed the stale `cropperjs/dist/cropper.css` import from the SaaS app root layout. Cropper.js v2 ships its styles inside its web components, and the CSS file no longer exists in the package, which broke the Next.js production build. Aligned the avatar crop dialog with the TanStack Start implementation, including shade clipping and layout styles for the Cropper.js v2 web component API.

### Changed

#### Mail

- **Default provider**: Switched the default mail provider export from Plunk to Resend. The Plunk provider implementation and `PLUNK_API_KEY` example environment variable were removed.

#### Dependencies

- **Production dependencies**: Bumped `fumadocs-core` and `fumadocs-ui` to `16.11.4`, `fumadocs-mdx` to `15.1.1`, and `react-email` to `^6.8.1`. Skipped `ai` `7.0.26`, `@ai-sdk/*` `4.0.13`/`4.0.14`/`4.0.27`, and `@aws-sdk/*` `3.1086.0` because they were published within the last 24 hours, plus `typescript` `7.x` (major upgrade pending ecosystem support) and `@types/uuid` (deprecated). Refresh the lockfile with `pnpm install` after pulling. `pnpm-workspace.yaml` enforces `minimumReleaseAge: 1440` (one day) at install time.
- **Development dependencies**: Bumped `postcss` to `8.5.19`. Skipped `turbo` `2.10.5` because it was published within the last 24 hours.

---

## 2026-07-14

### Changed

#### Dependencies

- **Production dependencies**: Bumped `@orpc/*` to `1.14.8`, `hono` to `^4.12.30`, `nanoid` to `^6.0.0`, and `react-dropzone` to `^17.0.0`. Synced the lockfile for catalog upgrades from previous runs (including `ai` 7.x, `@ai-sdk/*` 4.x, `cookie` 2.x, and `cropperjs` 2.x). Skipped `typescript` `7.x` (major upgrade pending ecosystem support) and `@types/uuid` (deprecated). Refresh the lockfile with `pnpm install` after pulling. `pnpm-workspace.yaml` enforces `minimumReleaseAge: 1440` (one day) at install time.
- **Development dependencies**: Bumped `postcss` to `8.5.18` and `tsx` to `^4.23.1`.

---

## 2026-07-13

### Changed

#### Dependencies

- **Production dependencies**: Bumped `fumadocs-core` and `fumadocs-ui` to `16.11.3`. Skipped `typescript` `7.x` (major upgrade pending ecosystem support) and `@types/uuid` (deprecated). Refresh the lockfile with `pnpm install` after pulling. `pnpm-workspace.yaml` enforces `minimumReleaseAge: 1440` (one day) at install time.
- **Development dependencies**: Bumped `postcss` to `8.5.17`.

---

## 2026-07-12

### Changed

#### Dependencies

- **Production dependencies**: Bumped `ai` to `^7.0.22`, `@ai-sdk/anthropic` to `^4.0.12`, `@ai-sdk/react` to `^4.0.23`, `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` to `3.1085.0`, `hono` to `^4.12.29`, `next-intl` to `4.13.2`, `use-intl` to `^4.13.2`, `fumadocs-core` / `fumadocs-ui` to `16.11.2`, and `react-email` to `^6.7.0`. Synced the lockfile for catalog upgrades from the previous run. Skipped `typescript` `7.x` (major upgrade pending ecosystem support) and `@types/uuid` (deprecated). Refresh the lockfile with `pnpm install` after pulling. `pnpm-workspace.yaml` enforces `minimumReleaseAge: 1440` (one day) at install time.
- **Development dependencies**: Bumped `oxfmt` to `0.58.0`, `oxlint` to `1.73.0`, `turbo` to `2.10.4`, and `@types/node` to `26.1.1`.

---

## 2026-07-11

### Changed

#### Dependencies

- **Production dependencies**: Bumped `ai` to `^7.0.19`, `@ai-sdk/anthropic` to `^4.0.11`, `@ai-sdk/openai` to `^4.0.11`, `@ai-sdk/react` to `^4.0.20`, `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` to `3.1084.0`, `dodopayments` to `^2.42.2`, `lucide-react` to `^1.24.0`, `openai` to `^6.46.0`, `react-email` to `^6.6.9`, and `stripe` to `^22.3.1`. Skipped `typescript` `7.x` (major upgrade pending ecosystem support) and `@types/uuid` (deprecated). Refresh the lockfile with `pnpm install` after pulling. `pnpm-workspace.yaml` enforces `minimumReleaseAge: 1440` (one day) at install time.

---

## 2026-07-10

### Changed

#### Dependencies

- **Production dependencies**: Synced the lockfile with the catalog major upgrades (`ai` `^7.0.16`, `@ai-sdk/*` `^4.0.x`, `cookie` `^2.0.1`, `cropperjs` `2.1.1`, `resend` `^6.17.2`, `nodemailer` `^9.0.3`, and related packages). Bumped `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` to `3.1083.0`.
- **Development dependencies**: Bumped `@types/node` to `26.1.1`. Skipped `ai` `7.0.18`, `@ai-sdk/react` `4.0.19`, `@ai-sdk/openai` `4.0.9`, and `@aws-sdk/*` `3.1084.0` because they were published within the last 24 hours. Refresh the lockfile with `pnpm install` after pulling. `pnpm-workspace.yaml` enforces `minimumReleaseAge: 1440` (one day) at install time.

---

## 2026-07-09

### Changed

#### Dependencies

- **Production dependencies**: Synced the lockfile with the catalog major upgrades (`ai` `^7.0.16`, `@ai-sdk/*` `^4.0.x`, `cookie` `^2.0.1`, `cropperjs` `2.1.1`, `resend` `^6.17.1`, `nodemailer` `^9.0.3`, and related packages). Bumped `dodopayments` to `^2.42.1`, `react-email` to `^6.6.8`, and `fumadocs-core` / `fumadocs-ui` to `16.11.1` and `fumadocs-mdx` to `15.1.0`.
- **Development dependencies**: Bumped `vitest` and `@vitest/coverage-v8` to `^4.1.10`, `turbo` to `^2.10.4`, `oxlint` to `^1.73.0`, and `oxfmt` to `^0.58.0`. Skipped `ai` `7.0.17`, `@ai-sdk/react` `4.0.18`, and `@aws-sdk/*` `3.1081.0` because they were published within the last 24 hours. Refresh the lockfile with `pnpm install` after pulling. `pnpm-workspace.yaml` enforces `minimumReleaseAge: 1440` (one day) at install time.

---

## 2026-07-08

### Changed

- **Dependabot**: Removed the `.github/dependabot.yml` configuration. Dependency updates are now manual or can be automated with AI agent tools such as Cursor Automations or Claude Code Routines. `pnpm-workspace.yaml` still enforces `minimumReleaseAge: 1440` (one day) at install time.

#### Dependencies

- **Production dependencies**: Bumped `ai` to `^7.0.16`, `@ai-sdk/react` to `^4.0.17`, `@orpc/*` to `1.14.7`, `hono` to `^4.12.28`, `dodopayments` to `^2.42.0`, `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` to `3.1080.0`, and `radix-ui` to `^1.6.2`.
- **Development dependencies**: Bumped `vitest` and `@vitest/coverage-v8` to `^4.1.10`, `turbo` to `^2.10.4`, `oxlint` to `^1.73.0`, and `oxfmt` to `^0.58.0`. Refresh the lockfile with `pnpm install` after pulling. `pnpm-workspace.yaml` enforces `minimumReleaseAge: 1440` (one day) at install time.

---

## 2026-07-07

### Changed

#### Dependencies

- **Production dependencies**: Bumped `@ai-sdk/openai` to `^4.0.8`. Other available updates (`ai` 7.0.16, `@ai-sdk/react` 4.0.17, `dodopayments` 2.42.0, `hono` 4.12.28, `@aws-sdk/client-s3` 3.1080.0, `oxlint` 1.73.0, `oxfmt` 0.58.0, and `turbo` 2.10.4) were skipped because they were published within the last 24 hours. Refresh the lockfile with `pnpm install` after pulling. `pnpm-workspace.yaml` enforces `minimumReleaseAge: 1440` (one day) at install time.

---

## 2026-07-06

### Changed

#### Dependencies

- **Production dependencies**: Bumped `ai` to `^7.0.15`, `@ai-sdk/anthropic` to `^4.0.8`, `@ai-sdk/react` to `^4.0.16`, `react-hook-form` to `^7.81.0`, and `dodopayments` to `^2.41.0`. Refresh the lockfile with `pnpm install` after pulling. `pnpm-workspace.yaml` enforces `minimumReleaseAge: 1440` (one day) at install time.

---

## 2026-07-05

### Changed

#### Dependencies

- **Production dependencies**: Bumped `recharts` to `^3.9.2` and `resend` to `^6.17.1`.
- **Development dependencies**: Bumped `@shikijs/rehype` to `^4.3.1`, `tsx` to `^4.23.0`, and `turbo` to `^2.10.3`. Refresh the lockfile with `pnpm install` after pulling. `pnpm-workspace.yaml` enforces `minimumReleaseAge: 1440` (one day) at install time.

---

## 2026-07-04

### Changed

#### Dependencies

- **Production dependencies**: Bumped `ai` to `^7.0.14`, `@ai-sdk/anthropic` to `^4.0.7`, `@ai-sdk/openai` to `^4.0.7`, `@ai-sdk/react` to `^4.0.15`, `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` to `3.1079.0`, and `react-email` to `^6.6.6`. Refresh the lockfile with `pnpm install` after pulling. `pnpm-workspace.yaml` enforces `minimumReleaseAge: 1440` (one day) at install time.
- **Development dependencies**: Bumped `tsx` to `^4.22.5`.

---

## 2026-07-03

### Changed

#### Dependencies

- **Production dependencies**: Bumped `ai` to `^7.0.11`, `@ai-sdk/anthropic` to `^4.0.5`, `@ai-sdk/openai` to `^4.0.5`, `@ai-sdk/react` to `^4.0.12`, `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` to `3.1078.0`, `next` to `^16.2.10`, `@next/third-parties` to `16.2.10`, `next-intl` and `use-intl` to `4.13.1`, `lucide-react` to `^1.23.0`, `nuqs` to `^2.9.0`, `radix-ui` to `^1.6.1`, `recharts` to `^3.9.1`, `nodemailer` to `^9.0.3`, and `sharp` to `^0.35.3`. Refresh the lockfile with `pnpm install` after pulling. `pnpm-workspace.yaml` enforces `minimumReleaseAge: 1440` (one day) at install time.
- **Development dependencies**: Bumped `@types/node` to `26.1.0`, `turbo` to `^2.10.2`, and `oxlint-tsgolint` to `^0.24.0`.

---

## 2026-07-01

### Changed

#### Dependencies

- **Production dependencies**: Bumped `ai` to `^7.0.7`, `@ai-sdk/anthropic` to `^4.0.2`, `@ai-sdk/openai` to `^4.0.3`, `@ai-sdk/react` to `^4.0.8`, Better Auth to `1.6.23`, `@better-auth/passkey` to `^1.6.23`, `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` to `3.1076.0`, `fumadocs-core` and `fumadocs-ui` to `16.10.7`, and `tailwindcss` to `4.3.2`. Refresh the lockfile with `pnpm install` after pulling. `pnpm-workspace.yaml` enforces `minimumReleaseAge: 1440` (one day) at install time.
- **Development dependencies**: Bumped `oxlint` to `^1.72.0`, `oxfmt` to `^0.57.0`, and `turbo` to `^2.10.1`.

---

## 2026-07-02

### Changed

#### Dependencies

- **Development dependencies**: Bumped `oxlint-tsgolint` to `0.24.0` and Turborepo to `2.10.2`. Refresh the lockfile with `pnpm install` after pulling. `pnpm-workspace.yaml` enforces `minimumReleaseAge: 1440` (one day) at install time.

---

## 2026-06-30

### Changed

#### Dependencies

- **Production dependencies**: Major upgrades — `ai` to `^7.0.4`, `@ai-sdk/anthropic` to `^4.0.1`, `@ai-sdk/openai` to `^4.0.2`, `@ai-sdk/react` to `^4.0.5`, `cookie` to `^2.0.0`, and `cropperjs` to `2.1.1`. Removed `react-cropper` in favor of native Cropper.js v2 integration in the avatar crop dialog. Refresh the lockfile with `pnpm install` after pulling. `pnpm-workspace.yaml` enforces `minimumReleaseAge: 1440` (one day) at install time.

---

## 2026-06-30 (earlier)

### Changed

#### Dependencies

- **Production dependencies**: Bumped `@ai-sdk/anthropic` to `^3.0.89`, `@ai-sdk/openai` to `^3.0.77`, `@ai-sdk/react` to `^3.0.216`, and `ai` to `^6.0.214`. Major-version upgrades for `ai` 7.x, `@ai-sdk/*` 4.x, `cookie` 2.x, and `cropperjs` 2.x were intentionally skipped pending migration work.
- **Development dependencies**: Bumped `@types/node` to `26.0.1` and `prettier` to `3.9.3`. Refresh the lockfile with `pnpm install` after pulling. `pnpm-workspace.yaml` enforces `minimumReleaseAge: 1440` (one day) at install time.

---

## 2026-06-30 (earlier)

### Changed

#### Dependencies

- **Production dependencies**: Bumped `lucide-react` to `1.22.0`, `date-fns` to `4.4.0`, `openai` to `6.45.0`, `postcss` to `8.5.16`, `autoprefixer` to `10.5.2`, `uuid` to `14.0.1`, and `start-server-and-test` to `3.0.11`. Major-version upgrades for `ai` 7.x, `@ai-sdk/*` 4.x, `cookie` 2.x, and `cropperjs` 2.x were intentionally skipped pending migration work.
- **Development dependencies**: Bumped `@types/node` to `25.9.4` and `@types/js-cookie` to `3.0.6`. Refresh the lockfile with `pnpm install` after pulling. `pnpm-workspace.yaml` enforces `minimumReleaseAge: 1440` (one day) at install time.

---

## 2026-06-29

### Changed

#### Dependencies

- **Production dependencies**: Bumped `@tanstack/react-query` to `5.101.2`, `dodopayments` to `2.40.1`, `fumadocs-core` to `16.10.6`, `fumadocs-mdx` to `15.0.13`, and `fumadocs-ui` to `16.10.6`. Major-version upgrades for `ai` 7.x, `@ai-sdk/*` 4.x, `cookie` 2.x, and `cropperjs` 2.x were intentionally skipped pending migration work. Refresh the lockfile with `pnpm install` after pulling. `pnpm-workspace.yaml` enforces `minimumReleaseAge: 1440` (one day) at install time.

---

## 2026-06-28

### Changed

#### Dependencies

- **Production dependencies**: Bumped Better Auth to `1.6.22`, `@better-auth/passkey` to `1.6.22`, `es-toolkit` to `1.49.0`, and `resend` to `6.16.0`. Major-version upgrades for `ai` 7.x, `@ai-sdk/*` 4.x, `cookie` 2.x, and `cropperjs` 2.x were intentionally skipped pending migration work. Refresh the lockfile with `pnpm install` after pulling. `pnpm-workspace.yaml` enforces `minimumReleaseAge: 1440` (one day) at install time.

---

## 2026-06-26

### Changed

#### Dependencies

- **Production dependencies**: Bumped 40+ production packages, including Next.js `16.2.9`, Better Auth `1.6.20`, oRPC `1.14.6`, Tailwind CSS `4.3.1`, AWS SDK S3 clients `3.1075.0`, Radix UI `1.6.0`, and other workspace runtime dependencies. Major-version upgrades for `ai` 7.x, `@ai-sdk/*` 4.x, `cookie` 2.x, and `cropperjs` 2.x were intentionally skipped pending migration work.
- **Development dependencies**: Bumped Turborepo to `2.10.0`, Oxlint to `1.71.0`, Oxfmt to `0.56.0`, Vitest to `4.1.9`, and Playwright to `1.61.1`. Refresh the lockfile with `pnpm install` after pulling. `pnpm-workspace.yaml` enforces `minimumReleaseAge: 1440` (one day) at install time.

---

## 2026-06-22

### Changed

#### Dependencies

- **Production dependencies**: Bumped `hono` to `^4.12.25` in the catalog and lockfile, and `nodemailer` to `^9.0.1` in the mail package. Refresh the lockfile with `pnpm install` after pulling.

---

## 2026-06-16

### Fixes and improvements

#### SaaS app

- **Organization members**: Removed the role permissions summary box from the members settings page. Role descriptions now appear only inside the role select dropdown (capped to one line), and the select trigger shows only the role label for a compact layout.

### Changed

#### Dependencies

- **Development dependencies**: Bumped Turborepo to `2.9.18` and `@tailwindcss/typography` to `0.5.20`. Refresh the lockfile with `pnpm install` after pulling.

---

## 2026-06-06

### Changed

#### Dependencies

- **Production dependencies**: Bumped `cookie` from `0.7.2` to `1.1.1` (major) across the lockfile.
- **Development dependencies**: Bumped `oxlint-tsgolint` to `0.23.0`, Turborepo to `2.9.16`, and `@content-collections/core` to `0.15.1`. Refresh the lockfile with `pnpm install` after pulling.

---

## 2026-06-04

### Changed

#### Dependencies

- **Production dependencies**: Bumped 29 production packages, including Next.js `16.2.7`, React and React DOM `19.2.7`, Better Auth `1.6.14`, Vitest `4.1.8`, `next-intl` `4.13.0`, and other workspace runtime and tooling dependencies. Refresh the lockfile with `pnpm install` after pulling.

---

## 2026-06-02

### Fixes and improvements

#### SaaS app

- **Organization settings**: Only organization owners now see the delete organization section in general settings. Admins still retain access to the rest of organization settings.

---

### Removed

#### Auth

- **Username plugin**: Removed the Better Auth `username()` plugin along with the `username` and `displayUsername` columns from the Prisma and Drizzle user schemas. This eliminates the unauthenticated `POST /api/auth/is-username-available` endpoint, which allowed anonymous username enumeration. Apply the schema change with `pnpm --filter @repo/database push` (this drops the two columns).

---

## 2026-05-27

### Changed

#### Infrastructure

- **Node.js and pnpm**: The workspace now requires Node.js `>=22` and pins `pnpm@11.3.0`. Turborepo was upgraded to the latest 2.9.x release.
- **Dependabot**: Removed the open-pull-requests limit and Dependabot cooldown so daily upgrade PRs are no longer capped at two concurrent updates. `pnpm-workspace.yaml` still enforces `minimumReleaseAge: 1440` (one day) at install time.
- **Lint tooling**: Moved `oxlint-tsgolint` from root dependencies to devDependencies so it is only installed for development workflows.

---

## 2026-05-25

### Fixes and improvements

#### Payments

- **Stripe one-time checkout**: Creating a checkout link for a user or organization that already has a Stripe customer no longer sends `customer_creation` alongside `customer`, which Stripe rejects with a parameter conflict error.

#### Marketing and SaaS apps

- **Theme toggle**: `ColorModeToggle` defers reading `next-themes` until after mount so the marketing and SaaS toggles render consistent server markup and client hydration without `suppressHydrationWarning`, fixing the active indicator jumping or mismatching on first paint.

#### Marketing

- **Content Collections**: `content-collections` config now uses the `content` option instead of the deprecated `collections` field (0.14+ migration), keeping the marketing content pipeline on the supported API.

---

## 2026-05-21

### Fixes and improvements

#### SaaS app

- **Organization members**: Role selects are ordered member → admin → owner (least to most access). The members settings page includes a role permissions summary, and each role option shows a short description of what it can do.

---

## 2026-05-20

### Removed

#### Mail

- **NewUser template**: Removed the unused `NewUser` email template, its `mailTemplates` wiring, orphaned per-locale `mail.json` entries, and the `common.otp` string that was only referenced there. Signup and email changes continue to use the email verification template.

### Changed

#### Dependencies

- **Workspace prune**: Dropped direct dependencies that were never imported from their package trees, removed the `openapi-schema` helper that only supported the removed `openapi-merge` dependency, and refreshed the lockfile so installs stay lean while type-check and tests keep passing.

---

## 2026-05-18

### Changed

#### Mail

- **React Email 6**: The mail workspace now uses the unified `react-email` package (v6). Separate `@react-email/components` and `@react-email/render` dependencies were removed in favor of imports from `react-email`. The mail preview app replaces `@react-email/preview-server` with `@react-email/ui` per the v6 upgrade guide. Email templates were reformatted with oxfmt.

---

## 2026-05-13

### Fixes and improvements

#### Infrastructure

- **Dependency minimum release age**: A 1-day minimum release age is now enforced at two levels to reduce supply chain attack exposure. Dependabot is configured with `cooldown: default-days: 1` so upgrade PRs are not opened immediately for freshly published versions. `pnpm-workspace.yaml` sets `settings.minimumReleaseAge: 1440` (minutes) so pnpm v11+ will also refuse to install any package version younger than one day, including transitive dependencies. Together these ensure a community-detection window before newly published — potentially compromised — versions reach the project.
- **pnpm v11**: The monorepo now targets pnpm `11.1.1`, with package-manager-only build settings moved from the root `package.json` into `pnpm-workspace.yaml` so installs and CI behave correctly on the v11 toolchain.

#### Marketing and SaaS apps

- **Theme toggle**: Light/dark controls in the marketing and SaaS apps render with correct server markup and no longer rely on a client-only placeholder that hid the toggle before hydration.

---

## 2026-05-09

### Fixes and improvements

#### Database

- **Two-factor authentication schema**: Added the missing Better Auth `verified` flag to the `TwoFactor` Prisma model, generated Prisma Zod schema, and PostgreSQL, MySQL, and SQLite Drizzle schemas so two-factor enrollment state is represented consistently across database adapters.

---

## 2026-05-06

### Fixes and improvements

#### SaaS app

- **Account security settings**: Passkeys can now be renamed from the passkey list, and the rename dialog opens automatically after creating a new passkey. The passkey list shows user-defined names without the device type prefix and falls back to “Unnamed passkey” for legacy passkeys without a saved name. The two-factor authentication block remains visible when a password has not been configured and now explains that a password is required before two-factor authentication can be enabled.

---

## 2026-04-24 v3.3.2

### Fixes and improvements

#### SaaS app

- **Organization general settings**: Organization name field now syncs when client data loads; success and error toasts use dedicated `organizations.settings` i18n keys. After renaming, the organization list query is refetched, the active organization is refreshed, and the name form resets to the saved value. The organization switcher no longer briefly shows “Personal account” when opening account settings with an active organization (active-org query keeps previous data across route key changes).

---

## 2026-04-20 v3.3.1

### Fixes and improvements

#### Database

- **Drizzle notifications and schema**: Notification persistence (preferences, insert support, listing rows, unread counts, mark read) is implemented in `@repo/database` for both Prisma and Drizzle, so the Drizzle scaffold no longer mixes in Prisma-style `db` calls. The Drizzle schema barrel (`drizzle/schema/index.ts`) re-exports the PostgreSQL schema (aligned with the Drizzle client) and exposes `NotificationType` / `NotificationTarget` for type-safe consumers.
- **`user.lastActiveOrganizationId` in Drizzle**: Added on PostgreSQL, MySQL, and SQLite user tables so Drizzle schemas match the Prisma user model and auth hooks that read this field.
- **Organization lookups (Drizzle)**: `findFirst`-based helpers now normalize missing rows to `null`, matching Prisma `findUnique` behavior for tests and callers.

#### Packages

- **`@repo/notifications`**: Dropped the thin `list`, `mark-read`, and `preferences` modules; the package index re-exports the shared notification query helpers from `@repo/database` next to create/welcome/resolve-link.

#### API

- **Notifications procedures**: List and unread-count handlers use the database row helpers from `@repo/notifications` / `@repo/database` and apply `resolveNotificationLink` when shaping list responses.

#### SaaS app

- **Notification center**: Removed interval-based refetching of notifications from the notification center UI.

Related: [issue #2395](https://github.com/supastarter/supastarter-nextjs/issues/2395) (Drizzle + Postgres scaffold parity).

---

## 2026-03-30 v3.3.0

### Added

#### Database

- **Notification entity**: New `Notification` model in Prisma and Drizzle (PostgreSQL, MySQL, SQLite) with user association and read/unread state.

#### Packages

- **`@repo/notifications`**: Shared module for notification definitions (`catalog`), creating and listing notifications, marking as read, per-user preferences, and a welcome notification helper.

#### API

- **Notifications oRPC**: Procedures to list notifications, get unread count, mark one or all as read, and read/update notification preferences.

#### SaaS app

- **Notification Center**: Navbar UI to view notifications and mark them read.
- **Notification preferences**: Account settings page and form for per-channel preferences; server-only notification logic is kept out of the client bundle for the preferences form.
- **Auth**: Database hook after user creation creates a welcome in-app notification via `@repo/notifications`.

#### Mail and i18n

- **`Notification` email template** and template wiring; **saas** and **mail** translation keys for notifications in English, German, Spanish, and French.

#### UI

- **Popover** and **Switch** components exported from `@repo/ui` for notification UI patterns.

### Changed

#### SaaS settings

- **Account and organization settings**: Removed nested `settings/layout.tsx` for account and org routes; settings sub-pages (general, billing, security, members, etc.) are updated to match the flatter structure. New **Notifications** route under account settings.

#### NavBar and theming

- **NavBar**: Reworked layout and behavior (including notification entry points); **Tailwind theme** (`tooling/tailwind/theme.css`) and related component tweaks for consistency.

---

## 2026-03-24 v3.2.0

### Testing

- **Vitest setup**: Added Vitest configuration (`vitest.config.ts`) to `apps/saas`, `apps/marketing`, and `packages/api` so unit tests can be run with `pnpm test` in each workspace package.
- **Unit tests**: Added initial unit test suites covering `base-url` helpers in both apps, content utilities in the marketing app, and organization membership logic, slug generation, and oRPC procedure wiring in the API package.
- **CI integration**: Added a unit test job to the GitHub Actions workflow so all unit tests run on every pull request; the Turbo `test` task no longer depends on `build`.

---

## 2026-03-24 v3.1.1

### Fixes and improvements

#### SaaS app

- **Checkout return after payment**: After Stripe checkout, users are redirected to `/checkout-return`, which polls `listPurchases` until an active plan appears (avoiding a race with webhook processing). The pricing table passes `organizationId` in the return URL when applicable. If confirmation does not arrive within the timeout, users are sent to `/choose-plan`. Added `checkoutReturn` copy in English, German, Spanish, and French.

---

## 2026-03-23 v3.1.0

### Tooling

- **Lint and format stack**: Replaced Biome with [Oxlint](https://oxc.rs/docs/guide/usage/linter) and [Oxfmt](https://oxc.rs/docs/guide/usage/formatter) for faster linting and formatting across the monorepo.
- **Workspace layout**: Consolidated Oxlint/Oxfmt dependencies at the repository root (pnpm catalog) and removed redundant per-package Biome configs; lockfile and many source files were updated to match the new rules and formatter output.

---

## 2026-03-18 v3.0.3

### Added

#### Organizations

- **Persist last active organization**: A new `lastActiveOrganizationId` field is stored on the user record whenever the active organization changes. On next sign-in, the session is automatically restored to that organization via a better-auth `databaseHook`, so users no longer land on a default/empty organization after logging back in.

---

## 2026-03-09 v3.0.2

### Fixes and improvements

#### Marketing app

- **Tailwind Typography**: Added `@tailwindcss/typography` plugin to the marketing app so `prose` and `prose-invert` classes render styled content correctly (blog posts, legal pages, changelogs)
- **Page spacing**: Normalized top padding across marketing pages (blog list, blog post, changelog, contact, legal) from `pt-24 pb-16` to `py-16` for consistent vertical rhythm
- **Image hostname**: Added `picsum.photos` to the allowed remote image hostnames in `next.config.ts` for blog placeholder images

---

## 2026-03-08 v3.0.1

### Fixes and improvements

#### i18n and translation usage

- **Single `useTranslations()` per component**: Removed redundant `useTranslations()` hooks (e.g. `tSignup`, `tLogin`, `tSettings`, `tPricing`, `tActions`, `tAria`, `tAvatar`, `tOrgSettings`) across marketing and SaaS components. Components now use a single `t` for all translation keys.
- **Color mode labels**: Marketing and SaaS `ColorModeToggle` now use the full key path `common.colorMode.${option.value}` for option labels.
- **Organization and settings keys**: `ChangeOrganizationNameForm` now uses `organizations.settings.changeName.notifications.success` / `error` and `settings.save` via the shared `t`; other organization and settings forms (delete org, logo, change email/name/password, two-factor) use the single `t` for their copy.

#### Payments and purchases

- **List purchases enrichment**: `listPurchases` (packages/api) now returns each purchase with resolved `planId` and `planPrice` from the payments helper, so clients receive plan data without extra lookups.
- **Purchase helper**: `createPurchasesHelper` and `getActivePlanFromPurchases` in `packages/payments` now accept a `ResolvedPurchase` type (with optional `planId` and `planPrice`) and use `resolvePurchasePlan` / `resolvePurchasePlanId` to avoid duplicate provider price resolution when purchases are already enriched.

#### UI

- **SaaS NavBar**: Nav link list uses `flex-nowrap`, `overflow-x-auto`, and responsive `md:overflow-visible md:flex-wrap` so links scroll horizontally on small screens and wrap on larger ones; sidebar layout keeps `md:flex-nowrap` for the vertical nav.

---

## 2026-03-08 v3.0.0

### Major architectural changes and breaking updates

This release restructures the monorepo around separate marketing and SaaS applications, expands localization, and reworks billing configuration. The major version bump reflects multiple breaking changes to app paths, imports, route structure, configuration, and payment data.

#### Summary of breaking changes

- **App split**: The former `apps/web` application has been split into dedicated `apps/marketing` and `apps/saas` Next.js apps
- **Route changes**: Marketing routes and SaaS auth/app routes moved into new App Router layouts and path groups
- **Config scoping**: Marketing and SaaS now use app-local `config.ts`, `types.ts`, and i18n request/config helpers instead of sharing `apps/web` config
- **Payments model**: Billing now uses plan-based configuration and provider `priceId` values instead of client-facing `productId`
- **Purchase schema**: Purchase records were renamed from `productId` to `priceId` across Prisma, Drizzle, and generated Zod schemas
- **i18n split**: Translations are now split by scope (`marketing`, `saas`, `mail`, `shared`) and loaded through a new `getMessagesForLocale` helper
- **Translation key updates**: Marketing and SaaS UI copy now uses full-length translation keys consistently across forms, nav, pricing, settings, admin, and auth flows
- **API removals**: The contact and newsletter API routers were removed from `packages/api`
- **Mail changes**: Newsletter signup email/template support was removed and mail rendering now resolves scoped translations from `@repo/i18n`
- **UI moves**: Several SaaS-specific UI primitives were moved out of `@repo/ui` into `apps/saas/modules/shared`
- **Workspace tooling**: The workspace now relies on a pnpm catalog for shared dependency versions

#### Dedicated marketing and SaaS applications

- **New apps**: Added standalone `apps/marketing` and `apps/saas` applications with their own `package.json`, `next.config.ts`, `tsconfig.json`, global styles, robots, layouts, config, and Playwright setup
- **Marketing app**: Public pages now live in `apps/marketing`, including home, blog index and post routes, changelog, contact, legal pages, sitemap generation, locale switching, and refreshed home-page sections
- **SaaS app**: Protected application routes now live in `apps/saas`, with separate authenticated and unauthenticated layouts, account dashboards, organization settings, onboarding, auth pages, and API routes
- **Removed**: Deleted the old combined `apps/web` app and its shared layouts, proxy, sitemap, and duplicated feature modules

**Migration steps:**

1. Update any scripts, deploy targets, env vars, or local workflows that referenced `apps/web`
2. Point public-site work to `apps/marketing` and protected-product work to `apps/saas`
3. Update route assumptions for auth pages (`/login`, `/signup`, etc.) and SaaS app layouts if you maintain custom links or middleware

#### Localization and content restructuring

- **Scoped translations**: Split locale files into `packages/i18n/translations/{locale}/marketing.json`, `saas.json`, `mail.json`, and `shared.json`
- **New locales**: Added Spanish (`es`) and French (`fr`) alongside English and German
- **Typed config**: Added typed i18n config/interfaces and exported `config`, `Locale`, and scoped message types from `@repo/i18n`
- **Message loading**: Added `getMessagesForLocale(locale, scope)` with shared-message merging and default-locale fallback behavior
- **Key normalization**: Updated marketing and SaaS components to use explicit full-length translation keys instead of shorter or ambiguous key paths
- **App wiring**: Marketing and SaaS now each own their locale request/update helpers and locale-aware providers

**Migration steps:**

1. Move any custom translation keys into the new scoped translation files
2. Replace imports of old flat message utilities with `getMessagesForLocale`
3. Rename any custom UI translation lookups that still rely on older short-form key paths
4. Update any code that assumed only `en` and `de` locales exist

#### Payments, auth, and data model updates

- **Plan-based checkout**: `createCheckoutLink` now accepts `planId`, `type`, and optional `interval`, then resolves provider price IDs server-side
- **Payments config**: Replaced `productId` pricing config with typed plan definitions, `priceId` fields, `requireActiveSubscription`, and reusable plan lookup helpers
- **Purchase queries**: `listPurchases` now accepts an optional input object by default, simplifying direct server/client calls
- **Database schema**: Renamed purchase `productId` to `priceId` in Prisma and generated validation output
- **Auth updates**: Better Auth now uses the SaaS base URL, raises the minimum password length to 8, reserves `chatbot` as an organization slug, and updates invitation redirects to `/login` and `/signup`

**Migration steps:**

1. Rename any custom purchase schema usage from `productId` to `priceId`
2. Update payment integrations to pass `planId` and `interval` rather than provider product IDs
3. Regenerate and apply database migrations if your environment still uses the old purchase column name
4. Verify `NEXT_PUBLIC_SAAS_URL` and payment provider price env vars are set for the new split-app setup

#### Mail, API, and shared component cleanup

- **Removed API endpoints**: Deleted the contact and newsletter oRPC modules from `packages/api`
- **Mail package refactor**: Moved mail helpers into `packages/mail/lib`, added scoped mail translation loading, and removed the newsletter signup template/export
- **Marketing forms**: Marketing contact/newsletter flows were refactored along with the new app split rather than continuing to rely on the removed shared API modules
- **SaaS UI ownership**: Moved password input, settings list/item, page header, and related shared components into the SaaS app to avoid over-generalizing them in `@repo/ui`
- **Workspace cleanup**: Added pnpm catalog version management and refreshed package wiring across apps and packages

---

## 2026-03-05 v2.0.6

### Refactoring

#### oRPC server-side client and payments

- **Server-side oRPC**: Introduced a server-only oRPC client that calls the API router directly (no HTTP) during SSR. Added `@orpc/server` (1.13.6) to `apps/web`, new `orpc.server.ts` that sets `globalThis.$orpcClient` via `createRouterClient(router, ...)`, and `instrumentation.ts` plus root layout import so the server client is registered before use.
- **orpc-client**: Client now throws on the server ("RPCLink is not allowed on the server side") and uses `window.location.origin` for the RPC URL; exports `orpcClient` as `globalThis.$orpcClient ?? createORPCClient(link)` so server code uses the direct router client.
- **API**: `packages/api` now exports `router`; `payments.listPurchases` procedure returns the purchases array directly instead of `{ purchases }`.
- **Payments**: Removed `getPurchases` and `apps/web/modules/saas/payments/lib/server.ts`. Account and organization billing pages and choose-plan page now call `orpcClient.payments.listPurchases()` directly; removed `attemptAsync` (es-toolkit) in favor of direct `await`. `usePurchases` hook updated to use `data ?? []` to match the new procedure return shape.

---

## 2026-03-05 v2.0.5

### Fixes

#### SaaS app layout – purchase list organization scoping

- **Payments / organizations**: When redirecting unsubscribed users to the choose-plan page, `organizationId` is now only passed to the payments list when organizations are enabled **and** billing is attached to the organization (`billingAttachedTo === "organization"`). Previously, `organizationId` was passed whenever organizations were enabled, which could incorrectly scope or look up purchases by organization when billing was configured at the user level and cause a redirect loop.

---

## 2026-03-02 v2.0.4

### Dependency updates

#### oRPC upgrade

- **@orpc packages**: Upgraded from 1.13.2 to 1.13.6 across the monorepo
- **apps/web**: Updated `@orpc/client` to 1.13.6
- **packages/api**: Updated `@orpc/client`, `@orpc/json-schema`, `@orpc/openapi`, `@orpc/server`, and `@orpc/zod` to 1.13.6

---

## 2026-02-05 v2.0.3

### Radix UI dependency consolidation

#### Unified Radix UI package migration

- **Major dependency update**: Migrated from individual `@radix-ui/react-*` packages to unified `radix-ui` package (v1.4.3)
- **Consolidated dependencies**: Replaced 13 separate Radix UI packages with a single `radix-ui` package
- **Updated all UI components** to use new unified package imports:
  - `accordion.tsx`: Updated to use `Accordion` from `radix-ui`
  - `alert-dialog.tsx`: Updated to use `AlertDialog` from `radix-ui`
  - `avatar.tsx`: Updated to use `Avatar` from `radix-ui`
  - `button.tsx`: Updated to use `Slot` and `Slottable` from `radix-ui`
  - `dialog.tsx`: Updated to use `Dialog` from `radix-ui`
  - `dropdown-menu.tsx`: Updated to use `DropdownMenu` from `radix-ui`
  - `form.tsx`: Updated to use `Label` and `Slot` from `radix-ui`
  - `label.tsx`: Updated to use `Label` from `radix-ui`
  - `progress.tsx`: Updated to use `Progress` from `radix-ui`
  - `select.tsx`: Updated to use `Select` from `radix-ui` and migrated icons to Lucide
  - `sheet.tsx`: Updated to use `Sheet` from `radix-ui`
  - `tabs.tsx`: Updated to use `Tabs` from `radix-ui`
  - `tooltip.tsx`: Updated to use `Tooltip` from `radix-ui`

#### Icon migration

- **Replaced Radix icons**: Migrated from `@radix-ui/react-icons` to Lucide icons
- **Features component**: Replaced `MobileIcon` from Radix with `SmartphoneIcon` from Lucide
- **Select component**: Replaced `CheckIcon` from Radix with Lucide's `CheckIcon`
- Removed `@radix-ui/react-icons` dependency

#### Package updates

- **UI package**: Updated `packages/ui/package.json` to use unified `radix-ui` package
- **Web app**: Updated `apps/web/package.json` to use unified `radix-ui` package
- **Dependencies**: Reduced from 13 separate Radix packages to 1 unified package

**Benefits:**

- Simplified dependency management with single package
- Reduced bundle size and faster install times
- Consistent versioning across all Radix UI components
- Easier maintenance and updates

---

## 2026-02-05 v2.0.2

### AI Chat refactoring and UI improvements

#### AI Chat simplification

- **Major refactoring**: Simplified AI chat feature to streaming-only interface, removing chat persistence
- **Removed**: Chat storage and CRUD operations (create, list, find, update, delete, add-message procedures)
- **Removed**: `AiChat` database model from all schemas (Prisma, Drizzle MySQL/PostgreSQL/SQLite)
- **Removed**: Database queries for AI chats (`ai-chats.ts` files)
- **Simplified**: AI router now only exposes a single `stream` endpoint for real-time AI responses
- **Refactored**: `AiChat` component to use streaming without persistence, using `@ai-sdk/react`'s `useChat` hook
- **Simplified**: Chatbot pages removed prefetching logic for chat lists and individual chats
- **New**: `stream-message` procedure that streams AI responses without storing conversations

**Breaking changes:**

- Any code using `orpcClient.ai.chats.*` endpoints will need to be updated
- Database migrations will need to drop the `ai_chat` table if it exists
- Chat history persistence is no longer available - conversations are session-only

#### UI component improvements

- **NavBar**: Added conditional bottom border when scrolled (`border-b` when `!isTop`)
- **Button component**: Removed icon opacity styling (`[&>svg]:opacity-60`) for better icon visibility
- **Global styles**: Added consistent Lucide icon stroke-width (`1.75`) for improved icon rendering

---

## 2026-02-05 v2.0.1

### UI component enhancements and design improvements

#### Toast component redesign

- **Major enhancement**: Complete redesign of the toast component with custom styling and improved UX
- Added custom `Toast` component with support for different types (success, error, info, warning, loading, default)
- Added automatic icons for each toast type using Lucide icons
- Added helper functions: `toastSuccess`, `toastError`, `toastInfo`, `toastWarning`, `toastLoading`
- Added `toastPromise` function for handling async operations with loading/success/error states
- Improved visual design with type-specific border colors and icons
- Added support for action and cancel buttons in toasts
- All form components updated to use the new toast API

#### Color mode toggle redesign

- **Redesigned**: Changed from dropdown menu to a modern segmented control/toggle button style
- Added smooth sliding indicator animation for active state
- Replaced dropdown menu with inline toggle buttons for better UX
- Added tooltips for each color mode option (System, Light, Dark)
- Improved accessibility with proper ARIA labels and pressed states
- Added translations for color mode labels (`common.colorMode.system`, `common.colorMode.light`, `common.colorMode.dark`)
- Updated icon from `HardDriveIcon` to `MonitorCogIcon` for system mode

#### User menu improvements

- **Simplified**: Removed inline color mode selection submenu from user menu
- Color mode toggle now uses the standalone `ColorModeToggle` component
- Cleaner menu structure with better separation of concerns

#### Component styling updates

- **Select component**: Updated border radius from `rounded-md` to `rounded-lg` for consistency with design system
- **SettingsItem component**: Increased left column width from `280px` to `320px` for better content spacing
- **Theme colors**: Updated muted background color from `#1d1e1e` to `#191b1b` for improved contrast

#### Form components

- Updated all SaaS form components to use the new toast API:
  - Organization forms (Create, Change Name, Delete, Logo, Invite Member)
  - Settings forms (Change Email, Change Name, Change Password, Set Password, Delete Account, User Avatar, User Language)
  - Admin components (Organization Form, Organization List, User List)
  - Organization management components (Members List, Invitations List, Organization Select)
  - Security components (Passkeys Block, Two Factor Block, Active Sessions Block)
  - Customer Portal Button

---

## 2026-02-02 v2.0.0

### Major architectural changes and breaking updates

This release introduces significant architectural changes that require migration steps. The major version bump reflects multiple breaking changes across the codebase. All existing code has been updated to use the new structure, but custom code will need manual migration.

#### Summary of breaking changes

- **Docs application**: Moved from web app to standalone Next.js app (`apps/docs`)
- **UI components**: Moved from `apps/web/modules/ui/` to `packages/ui/`
- **Configuration**: Removed centralized `config/` package, now scoped to individual packages
- **Shared components**: Moved `Logo` and `Spinner` components to `@repo/ui`
- **Mail package**: Restructured directory layout (removed `src/`), removed Logo component and custom provider
- **Payments package**: Moved helper utilities from `src/lib/` to `lib/`
- **Mail preview app**: New `apps/mail-preview` application added for email previewing
- **Not-found pages**: New dedicated not-found pages for marketing and SaaS routes
- **Import paths**: All imports updated throughout codebase (275+ files changed)

#### Dedicated docs application

Documentation has been moved from the web app to a standalone Next.js application using fumadocs.

**Breaking changes:**

- Removed docs routes from `apps/web/app/(marketing)/[locale]/docs/[[...path]]/`
- Removed docs API route `apps/web/app/api/docs-search/route.ts`
- Removed `apps/web/app/docs-source.ts`
- Removed all docs content from `apps/web/content/docs/` (including `getting-started/` and `index.mdx`)
- Removed `TableOfContents` component from marketing shared components
- Removed docs image from `apps/web/public/images/docs/login.png`
- Updated `apps/web/content-collections.ts` to exclude docs content
- Updated `apps/web/app/sitemap.ts` to exclude docs routes

**New structure:**

- Created new `apps/docs` application using fumadocs
- Docs now run as a separate Next.js app (default port 3001)
- Docs content moved to `apps/docs/content/docs/`
- Uses fumadocs-ui for improved documentation experience
- Includes AI-powered page actions component
- New docs app has its own `package.json`, `tsconfig.json`, and `next.config.ts`

**Migration steps:**

1. If you have custom docs content, migrate it to `apps/docs/content/docs/`
2. Update any links pointing to `/docs/*` routes - docs are now served from the separate app
3. Remove any imports of `TableOfContents` component
4. Run `pnpm dev` in the `apps/docs` directory to start the docs server (or use `pnpm --filter @repo/docs dev`)
5. Update any CI/CD pipelines that build or deploy docs

#### UI components moved to packages

All UI components have been moved from the web app to a shared package for better reusability across the monorepo.

**Breaking changes:**

- Removed all UI components from `apps/web/modules/ui/components/` (25+ components including accordion, alert, button, card, dialog, form, input, select, etc.)
- Removed `apps/web/modules/ui/lib/index.ts`
- Removed `apps/web/components.json` (shadcn config file)
- All component imports throughout the codebase have been updated

**New structure:**

- Created `packages/ui` package containing all UI components
- Components now imported from `@repo/ui/components/[component-name]`
- Shared utilities (like `cn`) available from `@repo/ui`
- `components.json` moved to `packages/ui/components.json`
- Package includes all Radix UI dependencies and styling utilities

**Migration steps:**

1. Update all imports from `apps/web/modules/ui/components/*` to `@repo/ui/components/*`
2. Update imports of `cn` utility from `apps/web/modules/ui` to `@repo/ui`
3. Remove any references to `components.json` in the web app
4. Install `@repo/ui` as a dependency if using UI components in other packages
5. Update TypeScript path aliases if you had custom ones pointing to the old location

#### Configuration restructuring

The centralized config package has been removed in favor of scoped configuration files for better package isolation.

**Breaking changes:**

- Removed `config/` package entirely:
  - `config/index.ts`
  - `config/package.json`
  - `config/tsconfig.json`
  - `config/types.ts`
- All imports from `@repo/config` or `config` will fail
- Config is now scoped to individual packages

**New structure:**

- Each package now has its own `config.ts` file:
  - `apps/web/config.ts` - Web app configuration
  - `packages/api/config.ts` - API configuration
  - `packages/auth/config.ts` - Auth configuration
  - `packages/i18n/config.ts` - i18n configuration
  - `packages/mail/config.ts` - Mail configuration
  - `packages/payments/config.ts` - Payments configuration
  - `packages/storage/config.ts` - Storage configuration
- Root `config.ts` file for shared configuration

**Migration steps:**

1. Update imports from `@repo/config` or `config` to package-specific configs:
   - `import { config } from "@config"` for web app
   - `import { config as i18nConfig } from "@repo/i18n/config"` for package configs
2. Update any code referencing the old config package structure
3. Review each package's config file to understand what configuration is available
4. Update environment variable usage if config structure changed

#### Shared components cleanup

Removed unused shared components that are now available in the UI package.

**Breaking changes:**

- Removed `apps/web/modules/shared/components/Logo.tsx`
- Removed `apps/web/modules/shared/components/Spinner.tsx`
- All imports of these components throughout the codebase have been updated

**Migration steps:**

1. Replace any imports of `Logo` from `@shared/components/Logo` - Logo is now available from `@repo/ui`
2. Replace any imports of `Spinner` - use skeleton components from `@repo/ui` instead
3. Update any custom code that imports these components

#### Mail package restructuring

Mail package has been restructured with a flatter directory structure and improved organization.

**Breaking changes:**

- Removed `packages/mail/src/components/Logo.tsx` (use `@repo/ui` instead)
- Removed `packages/mail/src/provider/custom.ts` provider
- Restructured mail package directory layout:
  - `src/components/` → `components/` (PrimaryButton, Wrapper moved)
  - `src/provider/` → `provider/` (all providers moved)
  - `src/util/` → `util/` (send, templates, translations moved)
- Updated all mail provider implementations to use new config structure
- Updated all mail email templates to use new import paths

**New structure:**

- Flatter directory structure without `src/` directory
- Components, providers, and utilities at package root level
- New `packages/mail/config.ts` for mail configuration
- New `apps/mail-preview` application for email previewing (runs on port 3005)

**Migration steps:**

1. If using the Logo component in mail templates, import from `@repo/ui` instead:
   ```typescript
   import { Logo } from "@repo/ui";
   ```
2. If using custom mail provider, migrate to one of the supported providers:
   - Resend
   - Nodemailer
   - Mailgun
   - Postmark
   - Plunk
   - Console (for development)
3. Update mail provider configuration to use `packages/mail/config.ts`
4. Update any imports from `packages/mail/src/*` to `packages/mail/*`
5. Use `apps/mail-preview` app for previewing emails during development

#### Payments package restructuring

Payments package has been restructured with helper utilities moved to a new location.

**Breaking changes:**

- Moved `packages/payments/src/lib/customer.ts` → `packages/payments/lib/customer.ts`
- Moved `packages/payments/src/lib/helper.ts` → `packages/payments/lib/helper.ts` (new location)
- Removed old `packages/payments/src/lib/helper.ts` (duplicate removed)
- Updated payment provider implementations (Stripe, LemonSqueezy, DodoPayments, Polar)
- Updated payment procedures to use new config structure

**New structure:**

- Helper utilities now in `packages/payments/lib/` (without `src/` prefix)
- New `packages/payments/config.ts` for payment configuration

**Migration steps:**

1. Update imports from `packages/payments/src/lib/*` to `packages/payments/lib/*`
2. Update payment configuration to use `packages/payments/config.ts`
3. Review `packages/payments/lib/` directory for helper functions

#### Import path updates

All components and modules have been updated to use the new import paths throughout the entire codebase.

**Affected areas:**

- UI component imports across all modules (200+ files updated)
- Config imports throughout the codebase
- Shared component imports
- Mail template imports
- Payment provider imports

**Migration steps:**

1. Run `pnpm install` to ensure all workspace dependencies are linked correctly
2. Update any custom code using old import paths:
   - `apps/web/modules/ui/*` → `@repo/ui/*`
   - `@repo/config` → package-specific configs
   - `@shared/components/Logo` → `@repo/ui`
3. Run type checking: `pnpm type-check` to identify any remaining import issues
4. Update any custom scripts or build tools that reference old paths

#### Workspace configuration updates

The workspace structure has been updated to reflect the new package organization.

**Breaking changes:**

- `pnpm-workspace.yaml` still references `config` package (which was removed) - this should be updated manually
- Workspace now includes new `apps/docs` application
- Workspace includes new `packages/ui` package

**Migration steps:**

1. Update `pnpm-workspace.yaml` to remove the `config` entry:
   ```yaml
   packages:
     - apps/*
     - packages/*
     - tooling/*
   ```
2. Run `pnpm install` to refresh workspace links
3. Verify all packages are properly linked with `pnpm list --depth=0`

#### Biome configuration standardization

All Biome configurations have been standardized across the monorepo for consistency.

**Changes:**

- Updated all Biome configurations across packages to use consistent settings
- Standardized Biome config format: all package-level configs now extend root config with `"extends": "//"`
- Root `biome.json` contains shared configuration
- Package-specific `biome.json` files only override when needed
- Database package excludes Prisma-generated zod files from linting

**Migration steps:**

1. If you have custom Biome rules, ensure they follow the new pattern:
   ```json
   {
   	"root": false,
   	"extends": "//"
   }
   ```
2. Run `pnpm format` to apply new formatting rules
3. Run `pnpm lint` to check for any linting issues with new config

#### Package dependencies and workspace structure

Package dependencies have been updated to reflect the new architecture.

**Changes:**

- Added `@repo/ui` as a workspace dependency where needed
- Updated `pnpm-lock.yaml` with new workspace structure (2760+ lines changed)
- Removed dependencies on deleted `config` package
- Updated all package `package.json` files to reflect new structure
- Added `@repo/docs` workspace package
- Updated tooling packages (scripts, tailwind, typescript) with new dependencies
- Updated i18n translations (en.json, de.json) with new messages

**Migration steps:**

1. Run `pnpm install` to ensure all workspace dependencies are linked correctly
2. Verify workspace structure with `pnpm list --depth=0`
3. Check for any remaining references to `@repo/config` in `package.json` files

#### Monorepo organization improvements

The monorepo structure has been improved for better organization and maintainability.

**Changes:**

- Improved package boundaries and separation of concerns
- Better isolation between apps and packages
- Clearer dependency relationships
- New `apps/docs` application added to workspace
- New `apps/mail-preview` application added to workspace
- New `packages/ui` package for shared UI components
- Removed `config/` package in favor of scoped configs
- Flattened directory structures in mail and payments packages (removed `src/` directories)

**Benefits:**

- Better code organization and discoverability
- Clearer separation between application code and shared packages
- Easier to understand dependencies between packages
- Better support for independent package versioning

#### Other updates

**Documentation:**

- Updated `agents.md` to reflect new architecture and import paths
- Updated coding guidelines to reference new package structure
- Updated import examples to use new `@repo/ui` package

**Configuration:**

- Updated `.env.local.example` with new configuration structure
- Updated environment variable documentation

**Build and deployment:**

- Updated sitemap generation to exclude docs routes
- Updated content collections configuration to exclude docs
- Updated image proxy route configuration
- Updated `turbo.json` to use TUI interface (`"ui": "tui"`)

**New applications:**

- Added `apps/docs` - Standalone documentation application using fumadocs
- Added `apps/mail-preview` - Email preview application for development (port 3005)

**Not-found pages:**

- Added dedicated `not-found.tsx` pages for marketing routes (`apps/web/app/(marketing)/[locale]/not-found.tsx`)
- Added dedicated `not-found.tsx` pages for SaaS routes (`apps/web/app/(saas)/app/not-found.tsx`)
- Removed `NotFound` component from marketing shared components (now using Next.js not-found pages)

**TypeScript:**

- Updated TypeScript configurations across packages
- Updated path aliases in `tsconfig.json` files
- Added new type definitions for UI package exports
- Added TypeScript configs for new apps (docs, mail-preview)

---

## 2026-01-30 v1.3.5

### Design system updates and UI improvements

#### Visual design updates

- Updated color scheme: replaced `bg-card` with `bg-background` in navigation and app wrapper for better contrast
- Changed newsletter section background from `bg-primary/5` to `bg-muted` for consistency
- Removed borders from card components and dropdown menus for a cleaner look
- Updated button styles: changed from `rounded-md` to `rounded-full` for a more modern appearance
- Increased container max-width from `--container-6xl` to `--container-7xl` for better use of screen space

#### Typography improvements

- Increased heading sizes across marketing pages (Hero, Features sections)
- Adjusted letter spacing from `-0.02em` to `-0.01em` for improved readability
- Added max-width constraint to hero paragraph for better text flow

#### Component enhancements

- Enhanced changelog component: added title field to changelog items with improved layout
- Updated changelog section styling: switched to `rounded-3xl` with `bg-muted` background
- Improved dropdown menu styling: updated border radius and shadow for better visual hierarchy
- Updated settings item component: removed explicit border and rounded corners for cleaner appearance

---

## 2026-01-26 v1.3.4

### Enhanced organization dashboard with visual trend charts

The organization dashboard now includes interactive trend charts to make the UI more visual.

---

## 2026-01-12 v1.3.3

### Consolidated agent rules into single agents.md file

All coding agent guidelines have been consolidated into a single, comprehensive `agents.md` file in the repository root.

#### Removed files

- `claude.md` - Previous Claude-specific coding guide
- `.windsurfrules` - Windsurf editor rules
- `.cursor/rules/*.mdc` - All Cursor IDE rule files (7 files)

#### New files

- `agents.md` - Comprehensive 679-line guide covering:
  - Technology stack overview
  - Monorepo architecture and directory structure
  - Import conventions and path aliases
  - TypeScript best practices with code examples
  - React & Next.js patterns (Server vs Client Components)
  - API & Data Layer patterns (oRPC procedures, database queries)
  - Authentication & Authorization patterns
  - UI & Styling guidelines
  - Forms & Validation patterns
  - Internationalization
  - Configuration management
  - Tooling & Quality standards
  - Performance optimization guidelines
  - Code review checklist
- `claude.md` - Symlink to `agents.md` for Claude Code compatibility

This consolidation provides a single source of truth for all AI coding agents working with the codebase, regardless of the IDE or tool being used.

---

## 2026-01-10 v1.3.2

#### Package updates

- Updated all ORPC packages (`@orpc/client`, `@orpc/tanstack-query`, `@orpc/json-schema`, `@orpc/openapi`, `@orpc/server`, `@orpc/zod`) from `^1.11.2` to `1.13.2`

#### Code changes

- Removed experimental prefix from `SmartCoercionPlugin` import in `packages/api/orpc/handler.ts` (changed from `experimental_SmartCoercionPlugin` to `SmartCoercionPlugin`)

---

## 2026-01-02 v1.3.1

### Drizzle schema update for better-auth

Updated all drizzle schema files to be aligned with the changes in the latest better-auth version.

#### Schema updates

- **User table**: Added `displayUsername` field and `twoFactorEnabled` field with default value
- **Passkey table**: Added `aaguid` field for authenticator attestation GUID
- **Organization table**: Made `slug` field required (`notNull()`) and unique
- **Member table**: Added default value `"member"` for `role` field and added `cuid()` default function for `id` field
- **Invitation table**: Added `createdAt` field with default timestamp and default value `"pending"` for `status` field
- Added performance indexes on `invitation.organizationId` and `invitation.email` fields

#### Relation updates

- Updated `userRelations` to include `members` relation
- Changed `invitationRelations` from `inviter` to `user` for consistency with PostgreSQL schema
- Reorganized relation definitions to match PostgreSQL structure

---

## 2026-01-02 v1.3.0

### New design

- The UI design has been updated to a new, more modern look.

---

## 2025-12-22 v1.2.12

### Fixed Prisma configuration

#### Script updates

- Removed explicit `--schema=./prisma/schema.prisma` flags from all Prisma scripts (generate, push, migrate, studio)
- Scripts now use Prisma's default schema location, simplifying configuration

#### Configuration cleanup

- Moved `prisma.config.ts` file to the root of the database package

---

## 2025-12-21 v1.2.11

### Update dependencies

Updated next, react and react-dom to the latest versions.

---

## 2025-12-21 v1.2.10

### Fixed settings item component

Fixed an issue where the settings item component didn't apply the correct layout.

---

## 2025-12-17 v1.2.9

### Updated Prisma database push script

- Updated database `push` script to remove the deprecated `--skip-generate` flag

---

## 2025-12-17 v1.2.8

### Updated dependencies

#### Prisma major version upgrade

- Updated `@prisma/client` from `6.19.0` to `7.1.0`
- Updated `prisma` from `6.19.0` to `7.1.0`
- Updated `prisma-zod-generator` from `1.32.1` to `2.1.2`

#### Prisma configuration changes

- Moved `DATABASE_URL` configuration from `schema.prisma` datasource block to `prisma.config.ts` file
- The `url` field is now managed through the Prisma config file for better configuration management

#### Better-auth updates

- Updated `better-auth` from `1.4.4` to `1.4.7` in both web app and auth package
- Updated `@better-auth/passkey` from `^1.4.4` to `^1.4.7`

---

## 2025-12-16 v1.2.7

### TypeScript configuration improvements

#### Type safety enhancements

- Added explicit type assertions in Creem payment provider for better type safety

#### TypeScript config updates

- Added `jsx: "preserve"` to base TypeScript configuration
- Added `DOM.Iterable` to React library TypeScript configuration for better DOM type support

#### Cleanup

- Removed unused `test:webhook` script from payments package
- Removed unnecessary `type-check` script from tailwind config package

---

## 2025-12-16 v1.2.6

### Updated dependencies

- Updated `next` from `16.0.7` to `16.0.10`
- Updated `react` from `19.2.1` to `19.2.3`
- Updated `react-dom` from `19.2.1` to `19.2.3`

---

## 2025-12-16 v1.2.5

### Fixed prisma-zod-generator version

Pinned `prisma-zod-generator` to version `1.32.1` to prevent automatic upgrades to `1.32.2`, which contains breaking changes and is deprecated for Prisma 6.

---

## 2025-12-05 v1.2.4

### Updated DodoPayments integration

#### SDK upgrade

- Updated `dodopayments` package from `^2.5.0` to `^2.8.0`

#### Webhook improvements

- Refactored webhook handler to use SDK's built-in webhook verification instead of manual signature verification
- Moved webhook secret configuration to client initialization for better security
- Updated webhook event types to match new SDK version:
  - `checkout.session.completed` → `payment.succeeded`
  - `subscription.created` → `subscription.active`
  - `subscription.cancelled` → `subscription.expired`
  - Added support for `subscription.plan_changed` event
- Updated product ID extraction to use `product_cart` array structure from new SDK

---

## 2025-12-04 v1.2.3

### Improved admin list components

#### API changes

- Updated pagination parameters from `itemsPerPage`/`currentPage` to `limit`/`offset` for better consistency
- Changed `searchTerm` parameter to `query` across admin list endpoints
- Count functions now respect search queries, providing accurate pagination totals when filtering

#### Search improvements

- **Users list**: Now searches both name and email fields (case-insensitive)
- **Organizations list**: Improved to use case-insensitive search
- Search queries are now properly applied to both data fetching and count queries

#### UI improvements

- Replaced loading spinner with skeleton loaders for better visual feedback during data fetching
- Fixed pagination reset logic to prevent unnecessary page resets on initial component mount
- Improved loading state display with skeleton rows matching the table structure
- Fixed pagination display condition to properly check for total count

---

## 2025-12-03 v1.2.2

### Updated next, react and react-dom for security updates

A critical-severity vulnerability was found in react server components. We updated the related dependencies to the latest versions to fix the issue.

Read more about the issue here: https://vercel.com/changelog/cve-2025-55182

---

## 2025-12-01 v1.2.1

### Several small type issues fixed

Fixed type issues in ForgotPasswordForm, SetPasswordForm, ChangePasswordForm, and OrganizationRoleSelect components.

---

## 2025-12-01 v1.2.0

### Better-auth 1.4 upgrade

Upgraded `better-auth` from version `1.3.34` to `1.4.4`. This version introduces several breaking changes and improvements.

#### Migration steps

1. **Update dependencies:**
   - Update `better-auth` to `1.4.4` in both `apps/web/package.json` and `packages/auth/package.json`
   - Add `@better-auth/passkey` package (version `^1.4.4`) to `packages/auth/package.json`

2. **Update passkey plugin imports:**
   - In `packages/auth/auth.ts`: Change `import { passkey } from "better-auth/plugins/passkey"` to `import { passkey } from "@better-auth/passkey"`
   - In `packages/auth/client.ts`: Change `passkeyClient` import from `better-auth/client/plugins` to `import { passkeyClient } from "@better-auth/passkey/client"`

3. **Update magicLink callback signature:**
   - Change the `sendMagicLink` callback from `async ({ email, url }, request)` to `async ({ email, url }, ctx)`
   - Extract the request object from context: `const request = ctx?.request as Request`

4. **Update database schema:**
   - Run `pnpm db:push` or create a migration to add the following indexes:
     - `Session`: `@@index([userId])`
     - `Account`: `@@index([userId])`
     - `Verification`: `@@index([identifier])`
     - `Passkey`: `@@index([userId])` and `@@index([credentialID])`
     - `TwoFactor`: `@@index([secret])` and `@@index([userId])`
     - `Member`: `@@index([organizationId])` and `@@index([userId])`
     - `Invitation`: `@@index([organizationId])` and `@@index([email])`
   - Add `createdAt DateTime @default(now())` field to the `Invitation` model

These changes improve database query performance through additional indexes and align with better-auth 1.4's new plugin architecture where passkey functionality is now a separate package.

---

## 2025-11-25 v1.1.4

### Fix OpenAPI schema

Fixed was an issue that would cause custom OpenAPI endpoints to not be reachable throught the `/api` path.

---

## 2025-11-23 v1.1.3

### Fix active sessions block

Fixed an issue where the removing the current session from the active sessions block was causing a redirect loop on the login page.

---

## 2025-11-20 v1.1.2

### Fix missing organization settings item in navbar

When in the config file the `hideOrganization` option is set to true, the organization settings item was missing in the navbar.

---

## 2025-11-16 v1.1.1

### Remove unnecessary font-sans variable

Removed the unnecessary `--font-sans` variable from the theme.css file as it is already defined the the `layout.tsx` file where the font is imported and injected to the html element.

### Updated dependencies

All production and development dependencies have been updated to the latest versions.

---

## 2025-11-12 v1.1.0

### Add claude.md file

For a better coding experience with Claude Code, we have added a `claude.md` file to the root of the repository.
This file contains the coding guidelines for the project, and is used by Claude Code to generate code.

---

## 2025-11-12 v1.0.9

### Fix passkeys reload issue

Fixed an issue where the passkeys list was not being reloaded correctly after adding or deleting a passkey.

---

## 2025-11-12 v1.0.8

### Fix missing fields in auth schema

Added missing fields (`aaguid` for Passkey and `displayUsername` for User) in the schema.
This was causing the passkeys creation to fail.

---

## 2025-11-12 v1.0.7

### Fixed mobile menu closing issue

Fixed an issue where the mobile menu was not closing when clicking on a menu item.

---

## 2025-11-11 v1.0.6

### Fix content-collections schema

The content-collections schema will soon require the `content` field to be present in the schema, which previously was automatically generated.
We have added it to the schema to avoid breaking changes with the upcoming content-collections version.

### Updated production dependencies

All production dependencies have been updated to the latest versions.

### Fixed AI chat component

Fixed a validation issue in the AI chat component that was causing the `addMessageToChat` procedure to fail.

---

## 2025-11-11 v1.0.5

### Fix formatting

Ran `pnpm format` to fix formatting issues in the codebase.

### Updated all dependencies

Production and development dependencies have been updated to the latest versions.

---

## 2025-11-08 v1.0.4

### Fixed AI chat component

Fixed a type issue in the AI chat component.

### Fixed Tailwind CSS wrapper component in mail templates

As reported in #2173, some Tailwind CSS classes were not being applied correctly in the email wrapper.

### Added typescript as dev dependency to web app

Added typescript as dev dependency to fix the `pnpm type-check` command.

---

## 2025-11-08 v1.0.3

### Fixed schema error in addMessageToChat procedure

Fixed a schema error in the `addMessageToChat` procedure that was causing the OpenAPI schema to be invalid.

---

## 2025-11-03 v1.0.2

### Updated dependencies

---

## 2025-11-03 v1.0.1

### Updated React type definitions

Updated `@types/react` and `@types/react-dom` from version 19.0.0 to 19.2.2 to include the latest type definitions and bug fixes for React 19.

The pnpm overrides have been consolidated to the root `package.json` for better consistency across the monorepo.

### Optimized pnpm dependency installation

Added `onlyBuiltDependencies` configuration to pnpm settings to optimize installation time by only building Prisma-related packages (`@prisma/client`, `prisma`, and `prisma-zod-generator`) when needed. This reduces unnecessary rebuilds and speeds up dependency installation in the monorepo.

### Added pg dependency

Added `pg` (PostgreSQL client) as a dependency to support the Prisma Rust-free client migration. The `pg` package is required by the Prisma database adapter for PostgreSQL connections.

---

## 2025-11-03 v1.0.0

### Prisma client migration to Rust-free client

In order to reduce the bundle size of the client and improve performance, we have migrated to the Rust-free Prisma client.

#### Migration steps

If you are upgrading your supastarter project to this version, you need to update the way your prisma client is generated:

1. Update `prisma` and `@prisma/client` to the latest version.

2. In the `schema.prisma` file, change the `provider` to `prisma-client`, the `output` to `./generated` and set the `engineType` to `client`.

3. Update the `packages/database/prisma/client.ts` like this:

```ts
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/client";

const prismaClientSingleton = () => {
	if (!process.env.DATABASE_URL) {
		throw new Error("DATABASE_URL is not set");
	}

	const adapter = new PrismaPg({
		connectionString: process.env.DATABASE_URL,
	});

	return new PrismaClient({ adapter });
};

declare global {
	var prisma: undefined | ReturnType<typeof prismaClientSingleton>;
}

// biome-ignore lint/suspicious/noRedeclare: This is a singleton
const prisma = globalThis.prisma ?? prismaClientSingleton();

if (process.env.NODE_ENV !== "production") {
	globalThis.prisma = prisma;
}

export { prisma as db };
```

In case are using a different database than PostgreSQL, see the following documentation on which adapter to use: https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/no-rust-engine#3-install-the-driver-adapter

### Next.js 16 migration

If you are updating an existing project, work through the following steps to align with the new Next.js 16 defaults and Supastarter conventions:

1. Upgrade `next`, `react`, and `react-dom` to their latest stable releases in both `package.json` files (`package.json` at the root and `apps/web/package.json` if it exists).

2. Rename the middleware entry point:
   - Move `apps/web/middleware.ts` to `apps/web/proxy.ts`.
   - Inside the renamed file update the exported handler to `export function proxy(...)` (it was previously `middleware`).

3. Remove the inline ESLint configuration from `apps/web/next.config.ts`

4. Update the marketing docs layout `apps/web/app/(marketing)/[locale]/docs/[[...path]]/layout.tsx`, by changing the `DocsLayout` prop from `disableThemeSwitch` to `themeSwitch={{ enabled: true }}`.

See https://nextjs.org/docs/app/guides/upgrading/version-16 for full migration guide (beyond the supastarter codebase).

---

### Biome 2.3 upgrade

We have upgraded to Biome 2.3 which introduces some changes to how CSS files are handled and it currently doesn't support the format in which Tailwind CSS 4 is configured, so you need to update the `biome.json` file to ignore the `globals.css` file for now:

```jsonc
{
	"files": {
		"includes": [
			"**",
			"!zod/index.ts",
			"!tailwind-animate.css",
			"!!**/globals.css", // <- ignore this file
		],
	},
	"css": {
		"parser": {
			"tailwindDirectives": true, // <- enable tailwind directives parsing
		},
	},
}
```
