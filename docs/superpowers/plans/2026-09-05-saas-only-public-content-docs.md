# SaaS-Only Public Content and Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate all public product pages and Fumadocs documentation into `apps/saas`, then
retire the standalone Marketing and Docs applications.

**Architecture:** SaaS owns explicit same-origin public routes and a `/docs` Fumadocs subtree.
Public-content data and renderers live in focused SaaS modules; security-sensitive origin checks use
one canonical SaaS origin. Replacement behavior is proven before legacy directories are removed.

**Tech Stack:** Next.js App Router, React, TypeScript, next-intl, Content Collections where retained,
Fumadocs, Vitest, Playwright, Turborepo, pnpm.

**Spec:** `docs/superpowers/specs/2026-09-05-saas-only-public-content-docs.md`

## Global Constraints

- `apps/saas` is the only public runtime application; `apps/mail-preview` remains developer-only.
- Canonical public URLs use `NEXT_PUBLIC_SAAS_URL`; CORS/origin security stays allowlisted and
  fail-closed.
- Do not migrate starter/demo Blog, Changelog, Docs, or fake Contact behavior.
- Do not invent legal identity, jurisdiction, translations, usage claims, or Provider capabilities.
- Do not rename persisted `marketing-*` business identifiers without a data migration.
- Write route/behavior tests first and record genuine RED -> GREEN evidence.
- Agents share this working tree, must stay within assigned file ownership, must not revert another
  agent's edits, and must not commit, push, deploy, or start live external calls.

---

### Task 1: Lock the consolidated route and SEO contracts with failing tests

**Files:**

- Create: `apps/saas/app/public-routes.test.tsx`
- Modify: `apps/saas/app/sitemap.test.ts`
- Create: `apps/saas/modules/docs/lib/source.test.ts`
- Create: `apps/saas/tests/public-routes.spec.ts`
- Create: `apps/saas/tests/docs.spec.ts`
- Modify: `apps/saas/tests/seo.spec.ts`

**Interfaces:**

- Produces executable expectations for Tasks 2-4.
- The route contract is the table in the specification; expected sitemap paths are the literal
  array `["/", "/pricing", "/privacy", "/terms"]`.

- [ ] Add focused Vitest tests that import/render the intended public page modules, assert explicit
      canonical/robots metadata, footer links, exact sitemap entries, Docs `/docs` base/search URLs,
      and organization slug reservation.
- [ ] Add Playwright specifications for public routes, legacy redirects, Docs root/nested/search/LLM
      endpoints, and preservation of private-route `noindex,nofollow` behavior.
- [ ] Run the focused Vitest command and record failures caused by missing production routes/modules,
      not syntax, import-alias, or fixture errors.
- [ ] Do not add production code in this task.

### Task 2: Implement real public content inside SaaS

**Files:**

- Create: `apps/saas/app/(public)/{pricing,privacy,terms,blog,blog/[...path],changelog,contact}/page.tsx`
- Create: `apps/saas/modules/public-content/components/PublicPageShell.tsx`
- Create: `apps/saas/modules/public-content/components/PublicFooterLinks.tsx`
- Create: `apps/saas/modules/public-content/lib/{metadata,content}.ts`
- Create: `apps/saas/content/{legal,posts,changelog}/**`
- Modify: `apps/saas/modules/landing/components/LandingPage.tsx`
- Modify: `apps/saas/app/sitemap.ts`
- Modify: `packages/i18n/translations/{en,de,es,fr}/{shared,saas,marketing}.json` only as needed

**Interfaces:**

- Exposes public routes with the metadata/sitemap contract from Task 1.
- Exposes reusable footer links consumed by the landing page and public page shell.
- Contact consumes the configured support email and never accepts or logs form input.

- [ ] Run Task 1's public-content Vitest subset and confirm the expected RED failures.
- [ ] Implement `/pricing`, `/privacy`, `/terms`, `/blog`, factual initial article,
      `/changelog`, and `/contact` using Server Components and the existing SaaS locale request.
- [ ] Add the six public navigation destinations to the landing footer and exact four-route sitemap.
- [ ] Add translations with structural parity across `en`, `de`, `es`, and `fr`; legal content may
      explicitly fall back to English rather than using placeholder translations.
- [ ] Run the focused public-content Vitest subset and record GREEN output.

### Task 3: Integrate factual Fumadocs documentation under `/docs`

**Files:**

- Create: `apps/saas/source.config.ts`
- Create: `apps/saas/content/docs/**`
- Create: `apps/saas/modules/docs/{components,lib}/**`
- Create: `apps/saas/app/docs/**`
- Create: `apps/saas/mdx-components.tsx`
- Modify: `apps/saas/{package.json,next.config.ts,tsconfig.json,vitest.config.ts,.gitignore}`
- Modify: `apps/saas/app/globals.css`
- Modify: `packages/auth/config.ts` and its focused tests to reserve `docs`

**Interfaces:**

- Fumadocs source base URL is `/docs`.
- Search is `/docs/api/search`; LLM/raw/OG artifacts remain below `/docs`.
- Generated source is imported through a normal `.source` alias, never
  `fumadocs-mdx:collections/server`.

- [ ] Run Task 1's Docs/source tests and confirm the expected RED failures.
- [ ] Move the reusable Fumadocs structure into a nested SaaS layout without `<html>/<body>` or a
      second theme provider; add scoped styles and dependencies.
- [ ] Replace placeholder Docs with factual EzPic overview, quick-start, image-editing, credits, and
      privacy material; ensure every page has a description.
- [ ] Namespace search, LLM, raw MDX, and OG routes and ensure generated/internal URLs start `/docs`.
- [ ] Reserve `docs` as an organization slug and reserve endpoint-owned Docs content slugs.
- [ ] Generate source, run focused Docs tests, and record GREEN output under the supported bundlers.

### Task 4: Retire legacy applications and collapse origin/build configuration

**Files:**

- Delete: `apps/marketing/**`
- Delete: `apps/docs/**`
- Modify: `package.json`, `pnpm-lock.yaml`, `.env.local.example`
- Modify: `.github/workflows/validate-prs.yml`
- Modify: `tests/load/{run-unit-contracts.ts,verify-ci-workflow.mjs,ezpic-production.js}`
- Modify: `tooling/scripts/verify-public-ui-originality.mjs`
- Modify: `tooling/e2e/src/run.ts`
- Modify: `apps/saas/{config.ts,types.ts,playwright-local-media.test.ts}` and relevant navigation
- Modify: `packages/config/**` and focused tests
- Modify: `packages/api/**` origin/CORS/draft/moderation consumers and focused tests
- Modify: `pnpm-workspace.yaml` only for catalog entries with no remaining consumers
- Modify: `agents.md`, `README.md`, applicable `.agents/skills/**`, active product/operations docs,
  and `CHANGELOG.md`

**Interfaces:**

- Active configuration has one canonical public origin: `NEXT_PUBLIC_SAAS_URL`.
- Root `dev`, `build`, and `start` target only `saas`.
- Persisted analytics/ledger/rate-limit identifiers remain stable.

- [ ] Write or update focused config/API tests so removing the legacy origin variables produces RED
      against current dual-origin code.
- [ ] Collapse production launch, guest admission, CORS, moderation, draft handoff, E2E, and load
      configuration to the single SaaS origin; run focused tests to GREEN.
- [ ] Remove the two legacy apps, replace originality/CI/test wiring with SaaS-only equivalents, and
      regenerate the lockfile using pnpm.
- [ ] Update current repository guidance and product/operations documentation without rewriting
      historical plans or changelog evidence.
- [ ] Run static residue checks and focused config/API/SaaS tests.

### Task 5: Certify the SaaS-only workspace

**Files:**

- Modify only files required to correct verified integration failures.

**Interfaces:**

- Consumes the consolidated routes, Docs source, single-origin security configuration, and pruned
  workspace graph from Tasks 2-4.

- [ ] Run `pnpm install --frozen-lockfile`, SaaS generation, focused Vitest and Playwright suites,
      CI workflow verification, and public-originality verification.
- [ ] Run root formatting, lint, type-check, unit/integration tests, and build because this change is
      cross-workspace and security-sensitive.
- [ ] Smoke-check `/`, `/pricing`, `/privacy`, `/terms`, `/blog`, `/changelog`, `/contact`, `/docs`,
      nested Docs, search, LLM output, `/api/docs`, and representative private routes.
- [ ] Confirm ports `3001` and `3002` are not required, no task-owned processes remain, and the Git
      diff contains only intended files with no credentials.
- [ ] Obtain one feature-level independent review; fix Important findings and rerun the affected
      verification before reporting completion.
