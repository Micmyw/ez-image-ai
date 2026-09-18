# Pending subscription checkout recovery

Reviewed against PayPal's Subscriptions OpenAPI and Waffo Pancake SDK 0.19.1 on
2026-09-18. This document separates the local expiry fixes from the proposed replacement
flow. It does not certify a live cancellation, payment, or deployment.

## What an unfinished checkout means

Opening checkout is not a paid subscription. It can still create a provider resource
before the buyer signs in or approves payment:

| Provider | Resource before payment                                                                                                                  | Cancellation and expiry evidence                                                                                                                                                                                  |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PayPal   | Creating a subscription returns an `I-...` identifier and approval link; `APPROVAL_PENDING` means created but not approved by the buyer. | The documented `/cancel` error contract permits `ACTIVE` or `SUSPENDED`. Do not assume it can cancel `APPROVAL_PENDING`. No verified fixed approval-link lifetime was found.                                      |
| Waffo    | Authenticated checkout creates a session plus a separate authentication token. An order may not exist yet.                               | The session defaults to 45 minutes; the token expires after 5 minutes. `orders.cancelSubscription` documents `pending` to `canceled`, and `active`/`trialing` to `canceling`. The latter awaits PSP confirmation. |

A read-only inspection of the reported production incident found a local
`PROVIDER_PENDING` intent with no expiry or canonical subscription. PayPal returned
`404 RESOURCE_NOT_FOUND / INVALID_RESOURCE_ID`, while the same credentials could read
the matching active plan. This explains why the current generic inspection remains
`UNKNOWN`; it does **not** prove that the original approval link can no longer charge.
The customer's absence of a visible PayPal agreement is also not a closure receipt.

## Local fixes in this change

- Persist Waffo's session `expiresAt`, not the earlier `tokenExpiresAt`.
- Preserve the PayPal/Waffo subscription admission fence when a checkout link expires,
  including direct retries, alias retries, same-plan replacement and another provider.
  Expiry does not settle a payment initiated earlier or a delayed payment notification.
- Keep the Prisma and Drizzle admission paths aligned. Existing credit-pack and legacy
  Stripe expiry behavior is unchanged.

These changes do not cancel provider resources, migrate old expiry values, repair
previously `EXPIRED` intents, refresh expired Waffo authentication tokens, or enable
self-service abandonment. The reported PayPal intent has not been changed.

### Verification of the local fixes

The Waffo expiry regression and three expired-subscription retry cases failed before
their fixes and passed afterward. The final relevant checks passed: 269 payment-provider
tests, 32 database unit tests, 32 checkout API tests, affected package type checks,
formatting and lint.

An isolated PostgreSQL 17 container on loopback port 55432 applied all 52 migrations.
Both affected persistence/admission integration suites passed (34 tests), including
concurrent cross-provider admission, expired links, immutable replay and owner isolation.
These are local database results; PayPal manual activation and Waffo session revocation
remain unverified external prerequisites for the proposed flow below.

## Proposed replacement flow — not yet implemented

Keep a selected replacement plan/cadence separate from the original immutable checkout.
The customer should see **Awaiting approval**, **Confirming payment**, **Closed**, or
**Needs review**, rather than a generic indication that they already subscribed.

1. Offer **Continue payment** and **Change plan**. On return/page entry, reconcile the
   owned pending attempt with a bounded retry policy. Avoid repeated browser polling
   that permanently returns the same unexplained `UNKNOWN` result.
2. Store a replacement request under the existing owner lock. Do not hold a database
   transaction while calling a provider. Persist provider operations and retries through
   the existing Outbox/job system, with stable keys and conditional state transitions.
3. Stop new admission while activation, cancellation, or payment acceptance is uncertain.
   After authoritative closure, atomically close the original attempt and authorize
   one replacement. Recheck paid subscriptions and received payment events in that
   transaction; use the same owner lock as checkout creation.
4. Preserve the original attempt and all payment history. Late events must enter the
   existing durable event/ledger path, including review/refund handling where required.
   An old browser tab or a client return parameter must never authorize activation.

### PayPal: evaluate merchant-controlled activation

The current integration sets `application_context.user_action = SUBSCRIBE_NOW`, allowing
PayPal to activate after buyer approval. The official `CONTINUE` description explicitly
allows the merchant to control activation. This is the preferred candidate for making
future abandoned attempts safely replaceable, subject to sandbox verification.

This requires a complete flow, not a parameter-only edit:

- Persist an activation mode on each new intent; retain `SUBSCRIBE_NOW` semantics for
  historical intents. Do not infer the original mode from current configuration.
- Verify the returned subscription ID, plan, owner correlation and provider approval on
  the server. Only the current owned attempt may enqueue activation.
- Atomically choose between superseding an unactivated attempt and claiming activation.
  Once activation is dispatched or uncertain, do not replace the attempt until reconciled.
- A superseded manual attempt must never activate, even if its old PayPal tab completes
  approval later. This revokes EzPic's permission to activate; it does not claim to erase
  PayPal's external URL.
- Prove `CONTINUE` approval followed by server activation in sandbox before enabling it.
  The published activation error schema also mentions suspended subscriptions, so the
  exact `APPROVED` activation path needs runtime evidence.

Historical auto-activation links need a separate recovery path. Record provider environment,
merchant/app provenance, immutable plan/session correlation, repeated inspection evidence
and financial-event checks. Persistent 404 must enter a durable review case with a support
reference. Neither a single 404, a guessed TTL, nor a local cancel flag is sufficient to
release it. Obtain authoritative provider closure/expiry evidence before any audited repair.

### Waffo: distinguish session, token, order and payment

- Persist the actual session deadline and separate token deadline/provenance. Resume an
  owned, unexpired session by renewing its authentication token through the documented
  auth boundary; do not create another checkout merely to refresh authentication.
- If a correlated subscription order exists in `pending`, request its cancellation and
  read it back. A successful HTTP response alone is not the final closure condition.
- Before allowing a replacement, prove the session can no longer create/reopen a payable
  order and all associated payment attempts are terminal and unpaid. The SDK documents
  order cancellation but no checkout-session revoke endpoint was found. Test reuse of
  the original URL after cancellation with Waffo; do not assume order cancellation also
  revokes the session.
- If there is only a session, wait for its actual deadline and reconcile related orders
  and payment attempts. An empty order query, authentication-token expiry, or an arbitrary
  extra delay is not independent proof that no payment is in flight.
- `canceling`, pending payments, payment history, multiple orders, correlation mismatch,
  warnings and unavailable queries must remain blocked for reconciliation/review.

The current Waffo adapter still has a 24-hour empty-result recovery heuristic and can
report a terminal unpaid order as `CLOSED` without independently proving session
revocation. Those existing assumptions must be verified or replaced before advertising
the proposed **Change plan** action as guaranteed closure. Older stored expiry values
may represent token expiry and must not be relabeled as authoritative session deadlines.

## Acceptance evidence for the complete flow

| Scenario                                                        | Required result                                                                                                                  |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Open PayPal, never sign in                                      | Show awaiting approval, without granting a subscription or credits.                                                              |
| Change a future manual PayPal attempt, then approve its old tab | The superseded attempt never activates or charges.                                                                               |
| Activation races with replacement                               | Exactly one operation wins; uncertain activation keeps admission blocked.                                                        |
| PayPal 404, timeout, wrong app/mode or mismatched plan          | No automatic unpaid/closed conclusion; bounded reconciliation and a durable review reference.                                    |
| Cancel Waffo pending order, then reuse original session URL     | Either the provider rejects every payment attempt, or replacement remains blocked until the session/payment boundary is settled. |
| Waffo token expires before session                              | No premature admission release; same-session token renewal preserves owner and order correlation.                                |
| Session expires during payment; webhook arrives late            | No second subscription is created; the original paid event is fulfilled exactly once.                                            |
| Two tabs/providers/plans request replacement                    | One owner-scoped replacement; no overlapping recurring subscriptions.                                                            |
| Another user or organization member submits an old intent ID    | Existing owner/billing-manager checks reject the action.                                                                         |
| Previously paid cancellation/refund                             | Preserve the existing subscription, period, refund and debt rules.                                                               |

Local mocks do not establish PayPal activation or Waffo session invalidation semantics.
Sandbox provider evidence and isolated PostgreSQL concurrency tests are prerequisites
for releasing the complete replacement flow.

## Sources

- [PayPal Subscriptions API](https://developer.paypal.com/docs/api/subscriptions/v1/)
- [PayPal official OpenAPI](https://github.com/paypal/paypal-rest-api-specifications/blob/main/openapi/billing_subscriptions_v1.json):
  `application_context.user_action`, `subscription_status`, `subscriptions.cancel-422`.
- [Waffo Pancake SDK API reference](https://github.com/waffo-com/waffo-pancake-sdk-ts/blob/main/docs/api-reference.md):
  authenticated checkout, session tokens and subscription cancellation; compared with
  the locally installed 0.19.1 reference.
