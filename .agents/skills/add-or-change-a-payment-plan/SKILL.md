---
name: add-or-change-a-payment-plan
description: Use when changing the configured plan catalog, price variants, billing ownership, or pricing UI data.
---

# Add or change a payment plan

## Scope

Use for plan IDs, subscription/one-time prices, trials, seats, and enterprise offers. Do not add a new provider implementation; use the payment-provider skill.

## Procedure

1. Edit `packages/payments/config.ts`. Plan keys become the typed `PlanId`; paid plans use `prices`, while sales-led plans use `isEnterprise: true`.
2. For each price, set `type`, major-unit `amount`, `currency`, and an env-backed `priceId`. Subscription prices also require `interval` and may set `seatBased` or `trialPeriodDays`.
3. Add each new price env name to `.env.local.example` with a placeholder. Keep provider IDs out of source and do not expose them with `NEXT_PUBLIC_`.
4. Add matching `pricing.products.<planId>` title, description, and feature keys to every locale in both `saas.json` and `marketing.json`. SaaS consumes them through `apps/saas/modules/payments/hooks/plan-data.tsx`; marketing reads them directly in `apps/marketing/modules/home/components/PricingSection.tsx`.
5. Check `packages/payments/lib/plans.ts` and `lib/provider-price-ids.ts`; they derive lookup mappings from config. Do not add a second hard-coded provider mapping.
6. Verify `billingAttachedTo`. User billing prefetches in `apps/saas/app/(authenticated)/layout.tsx`; organization billing prefetches in the `[organizationSlug]/layout.tsx` and may use seat counts.
7. Test checkout lookup and active-plan behavior. Exercise `apps/saas/modules/payments/components/PricingTable.tsx` for monthly/yearly, hidden, recommended, enterprise, and currency behavior.
8. Run API/SaaS/marketing tests, `pnpm format`, `pnpm lint`, and `pnpm type-check`.

## Canonical reference

`packages/payments/config.ts` defines monthly/yearly `pro`, one-time `lifetime`, and `enterprise`; `apps/saas/modules/payments/components/PricingTable.tsx` selects by interval and locale currency.

## Done

Every purchasable type/interval maps to one provider ID, both pricing UIs render every locale/interval variant, checkout resolves the intended plan, ownership/seat/trial behavior is correct, and relevant tests/gates pass.

## Common mistakes

- Storing provider price IDs directly in UI code.
- Expressing `amount` in cents; this config uses major units.
- Adding a plan key without translation-backed `planData`.
- Changing `billingAttachedTo` without checking layouts, checkout, and customer ownership.
- Updating SaaS pricing copy while leaving marketing's direct `PricingSection` lookups stale.
