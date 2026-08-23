---
name: add-a-payment-provider
description: Use when implementing or activating a payment provider for checkout, portal, subscriptions, and webhooks.
---

# Add a payment provider

## Scope

Use for provider SDK/API integration and webhook persistence. Do not change the plan catalog unless provider price IDs or supported price behavior also require it.

## Procedure

1. Implement `packages/payments/provider/<provider>/index.ts`. `PaymentProvider` in `packages/payments/types.ts` requires checkout, customer portal, and webhook functions; providers also export the shared cancellation and seat-update function types used by the package barrel.
2. Use `packages/payments/lib/customer.ts` and `lib/provider-price-ids.ts`; persist provider events through exported `@repo/database` purchase functions.
3. Verify webhook signatures against the raw `Request` body before mutation. Make create/update/delete handling idempotent and map provider price/product IDs through `getPlanIdByProviderPriceId`.
4. Export exactly one active provider from `packages/payments/provider/index.ts`. It currently exports Stripe; Lemon Squeezy, Polar, Creem, and Dodo implementations already exist but are dormant.
5. Add the provider's server-only credentials and webhook secret to `.env.local.example`. Note that Dodo code requires `DODO_PAYMENTS_WEBHOOK_SECRET`, which is currently absent from the example.
6. Reuse the existing endpoint `POST /api/webhooks/payments` in `packages/api/index.ts`; configure that URL in the provider dashboard rather than adding another route.
7. Add a dependency only if the provider implementation truly needs one; use pnpm in `@repo/payments` and current catalog policy.
8. Test signature rejection, supported event mappings, duplicate delivery/idempotency, subscription updates/deletes, organization/user metadata, and missing price IDs. The payments package currently has no `test` script, so add provider tests with an appropriate script if needed and always run the consuming `@repo/api` tests.
9. Run relevant provider/API tests, `pnpm format`, `pnpm lint`, and `pnpm type-check`.

## Canonical reference

`packages/payments/provider/stripe/index.ts` implements checkout, portal, seat changes, cancellation, signature verification, and purchase lifecycle persistence.

## Done

Exactly one provider barrel is active, every exported contract resolves, checkout/portal URLs work, raw-body signature verification precedes idempotent persistence, required env names (including webhook secret) are documented, and provider/API tests plus gates pass.

## Common mistakes

- Exporting multiple providers with colliding function names.
- Trusting webhook JSON before signature verification.
- Adding a new webhook path instead of using `/api/webhooks/payments`.
- Assuming all existing provider files are active; only the provider index export is active.
- Calling a nonexistent payments `test` script without first adding one.
