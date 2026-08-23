# Task 5 report: Stripe subscription and credit lifecycle

## Implemented

- Stripe is the certified media billing path. Checkout accepts the internal plan/interval selection,
  resolves the server-side Stripe price and versioned `BillingPlan`, and binds
  `billing_plan_id`, `plan_key`, `owner_type`, `owner_id`, and `submitted_by_user_id` metadata.
- The webhook verifies the Stripe signature over the raw body before an atomic
  `PaymentEvent` + Outbox persist. Duplicate provider event/normalized transaction IDs return 2xx;
  request processing never mutates subscription or credits.
- Payment events use lease-token/CAS processing. Ambiguous subscription binding creates a protected,
  replayable diagnostic. Subscription ordering ignores stale or terminal-reversing events and retains
  Purchase snapshots (including cancellation/deletion).
- `invoice.paid` is the only credit source. Monthly invoices create one internal period/grant; annual
  invoices create 12 UTC periods with anchor-day/last-valid-day semantics, while the scheduler grants
  only due periods for active subscriptions.
- Refunds resolve the original charge/period/grant, append reversal ledger rows, consume matching
  unspent lots first, create debt for spent credits, cap cumulative partial refunds, and rely on the
  Task 2 debt-first grant primitive for future repayment. The Task 4 reservation path continues to
  reject accounts with insufficient spendable credits (debt is never spendable).
- Checkout return is read-only over internal `Subscription`/`BillingPeriod`. Certified media pricing
  removes lifetime and exposes creator/studio monthly/yearly plans plus credits, concurrency, and
  storage sourced from `@repo/config`. Other Supastarter payment providers remain source-compatible,
  without being certified for this credit lifecycle.

## Verification

- Stripe unit fixtures cover raw signature verification, invalid signatures, duplicate-safe refund
  identifiers, immutable checkout metadata, UTC/EOM anchors, refund caps, and terminal ordering.
- PostgreSQL integration tests run only against
  `127.0.0.1:55432/ai_media_foundation_test` and cover monthly exact-once grants, annual 12-period
  scheduling/due grants, partial/multiple spent refunds and debt, cancellation Purchase retention, and
  stale reactivation rejection.
- The new Prisma migration was deployed only to that isolated test database.

## Operational notes

- Billing plans must be seeded with Stripe price IDs matching the server environment before checkout.
- The existing product configuration defines past-due as a grace entitlement for product access, but
  no new scheduled credit grant is issued while past due, canceled, unpaid, or expired.
- Stripe tests use generated test signatures and stored fixtures; no live Stripe calls were made.

## Lifecycle consistency hardening

- Refund and invoice normalization now uses namespaced object IDs, so multiple refunds on one charge
  and an invoice/refund sharing that charge persist independently. `charge.refunded` is no longer a
  certified processing source; `refund.created` and `charge.refund.updated` share refund-ID semantics.
- A claimed PaymentEvent is fenced by its current lease and processed in one serializable transaction.
  The processor locks and revalidates the event, applies all subscription/period/ledger mutations, and
  marks the event processed before commit. Serialization conflicts are retried; an expired or replaced
  lease cannot commit stale business changes.
- Annual refunds lock the full invoice group, derive credit entitlement from cumulative provider
  refunds, allocate the delta deterministically across periods, reverse granted credits through the
  ledger/debt path, and mark fully reversed future periods `REFUNDED`. The first period remains the
  canonical invoice financial snapshot even when a later refund reverses zero additional credits.
- Subscription creation serializes on the Stripe subscription ID and repairs a compatible pre-existing
  Purchase instead of inserting a duplicate. Concurrent replay creates one Subscription and one binding
  audit record. Subscription webhook plan changes remain scheduled until the matching paid invoice;
  stale events cannot schedule or activate a plan.
- Subscription synchronization persists paid-through and explicit grace deadlines. Reconciliation now
  expires canceled subscriptions only at `currentPeriodEnd`, and past-due subscriptions only at
  `graceEndsAt`. Checkout return remains user-only for the first release and rejects organization scope.

## Hardening verification

- Rebuilt only `127.0.0.1:55432/ai_media_foundation_test` from all 12 Prisma migrations; migration
  status reported the schema up to date. Prisma client and Zod artifacts were regenerated.
- Focused integration coverage includes cumulative annual rounding and caps, full future-period
  reversal, zero-credit monetary audit snapshots, stale lease fencing, compatible Purchase repair under
  concurrent replay, grace/cancellation deadlines, next-cycle and stale plan changes, raw Stripe
  signature verification through PaymentEvent + Outbox + production processing, and invoice/refund
  processing on one shared charge.
- Fresh passing suites: payments 9 tests; API 47 tests (including 13 Stripe lifecycle integration
  cases); database unit 28 tests and PostgreSQL integration 23 tests; jobs unit 1 test and PostgreSQL
  integration 13 tests; SaaS 12 tests; marketing 22 tests. Payments, database, jobs, API, SaaS, and
  marketing type checks passed. Changed files pass Oxfmt, Oxlint, and `git diff --check`.

## Hardening review round 2

- Every ordered subscription update with a server-mapped Stripe price now explicitly converges the
  scheduled plan: a different mapped plan schedules that plan, while a mapped return to the active
  plan clears the schedule. Missing or unmapped prices do not overwrite an existing schedule.
- PostgreSQL regression coverage proves active A -> newer B schedule -> still newer A reversion clears
  the schedule, a stale B event cannot restore it, and the following A `invoice.paid` creates the
  correct A credit grant without a scheduled-plan mismatch.
- Fresh review-round verification passed all 9 payments tests and 16 focused API payment tests;
  payments/API type checks, changed-file Oxfmt/Oxlint, and `git diff --check` also passed.
