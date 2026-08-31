# Multi-provider Payments and Model Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development while implementing the assigned functional task. Work only in the assigned worktree and commit the finished task.

**Goal:** Add customer-selectable PayPal/Waffo checkout and a safe multi-tier landing image editor with an OpenRouter provider boundary.

**Architecture:** Payment choices are resolved through a provider registry and provider-aware persistence; media choices remain stable public product keys and route through the existing quote/job/credit/private-media pipeline. Stripe and existing media providers remain supported for historical and fallback behavior.

**Tech Stack:** Next.js App Router, React, TypeScript, oRPC, Prisma/PostgreSQL, Vitest, Playwright, Trigger.dev, PayPal REST, Waffo Pancake SDK, OpenRouter Images API.

**Spec:** `docs/superpowers/specs/2026-08-31-multi-provider-payments-and-model-routing-design.md`

## Global Constraints

- Preserve all pre-existing snapshot content and do not touch the original dirty `main` checkout.
- Do not expose provider price IDs, AI provider/model IDs, raw costs, remote asset URLs, or credentials to browser code.
- Reuse PaymentEvent/Outbox, immutable credits, GenerationJob/Attempt, private MediaAsset, moderation, and reconciliation paths.
- Keep Stripe active for historical lifecycle processing.
- Missing provider credentials or billing snapshots must hide checkout availability and fail closed.
- OpenRouter adapter completion is not production route certification.
- Every new behavior must have a demonstrated RED run before implementation and a GREEN run afterward.

---

### Task 1: Customer-selectable PayPal and Waffo payments

**Ownership:** `packages/payments/**`, payment procedures and router wiring under
`packages/api/modules/payments/**` and `packages/api/index.ts`, payment processing under
`packages/jobs/**`, payment persistence/schema/migration under `packages/database/**`,
payment UI under `apps/saas/modules/payments/**`, payment translations, payment environment
configuration, payment operations docs, and task-specific changelog entries.

**Produces:**

- `PaymentProviderName` and a registry resolver with explicit capabilities.
- Server-derived provider availability and provider-aware checkout input.
- Provider-scoped customer, checkout intent, purchase, and subscription identities.
- Verified PayPal and Waffo webhook ingestion plus provider-dispatched processing.
- Provider-aware portal/cancellation/seat behavior.
- An accessible payment-method chooser that submits only the provider name.

- [ ] Write focused failing registry, provider price mapping, API checkout, webhook, database,
      and UI tests. Run each focused command and record the expected feature-absence failure.
- [ ] Implement the additive Prisma schema and migration, regenerate Prisma clients, and make
      existing Stripe tests green before introducing new provider event reducers.
- [ ] Implement the registry and migrate Stripe callers without changing Stripe behavior.
- [ ] Implement PayPal REST checkout/cancel/webhook verification and Waffo authenticated
      checkout/cancel/webhook verification behind injected HTTP/SDK boundaries.
- [ ] Normalize supported provider lifecycle events into safe billing facts; reject uncorrelated,
      stale, inconsistent, duplicate, or unsupported events without granting credits.
- [ ] Implement server-advertised availability and the client payment chooser, including
      capability-aware management actions for existing subscriptions.
- [ ] Run `pnpm --filter @repo/payments test`, focused `@repo/api` payment tests, focused database
      integration tests with an isolated database when available, SaaS payment tests, format, lint,
      and type-check. Commit with `feat: add selectable paypal and waffo payments`.

### Task 2: OpenRouter provider boundary and landing model selector

**Ownership:** `packages/ai/media/**`, OpenRouter-specific jobs/Trigger wiring,
guest media capability/admission/draft procedures under `packages/api/modules/media/**`, media
configuration needed for OpenRouter, landing components and landing client under
`apps/saas/modules/landing/**`, landing Playwright tests, marketing translations, and
AI-media operations docs. Do not edit payment files.

**Produces:**

- An `openrouter` media adapter with strict raster output parsing and conservative uncertainty.
- Static worker/Trigger registration for OpenRouter without an uncertified production route.
- Guest capability entries and draft persistence for allowed stable product keys.
- A responsive product-tier selector plus drag/drop, preview, removal, deterministic stages,
  retry guidance, and no provider/model/cost leakage.

- [ ] Write failing adapter tests for authentication, image references, one-result raster parsing,
      unsafe/malformed output, rejection versus uncertainty, and unsupported retrieve/idempotency.
- [ ] Implement the OpenRouter adapter and explicit worker/Trigger registration; keep the
      candidate routes disabled unless both provider enablement and the server-only certification
      gate are present. Pin the exact Sourceful fast/pro slugs and 21,000/170,000-micros ceilings,
      bump catalog/pricing versions, and keep timeout outcomes uncertain.
- [ ] Write failing guest capability/admission tests proving valid tier persistence and forged or
      unavailable product-key rejection, then implement the smallest end-to-end contract.
- [ ] Write failing landing unit/Playwright behavior for tier selection, drag/drop, preview/remove,
      disabled guidance, stage ordering, retry preservation, responsive layout, and leakage checks;
      then implement the compact desktop and purposefully reordered mobile generator.
- [ ] Run `pnpm --filter @repo/ai test`, focused `@repo/api` media tests, focused SaaS unit tests,
      `pnpm --filter saas e2e:ci` for the landing project when its browser server is available, format,
      lint, and type-check. Commit with `feat: add safe multi-model landing workflow`.

### Task 3: Integration, review, and original-workspace delivery

**Ownership:** Orchestrator only.

- [ ] Merge the two task commits into the snapshot integration branch and resolve only genuine
      shared configuration, translation, changelog, migration, or lockfile conflicts.
- [ ] Inspect the combined diff against every spec requirement and run one feature-level review
      focused on correctness, provider isolation, data integrity, credential leakage, and UI truth.
- [ ] Fix Important findings with focused RED → GREEN coverage; do not add speculative scope.
- [ ] Run database generation, focused payment/AI/API/SaaS tests, lint, format check, type-check,
      relevant Playwright/media E2E where prerequisites exist, and `git diff --check`.
- [ ] Apply only the feature diff from the snapshot baseline to the original dirty workspace,
      prove the original pre-existing changes remain present, rerun task-focused checks there, then
      remove the exact task-owned worktrees and local branches after patch-equivalence verification.
