# Pending subscription checkout recovery

Implemented 2026-09-19. Opening checkout may create a provider resource before buyer login.
It is not payment evidence. This flow uses existing PostgreSQL admission locks, immutable checkout
intent identities, Outbox delivery and the verified payment-event ledger pipeline.

## Customer flow

- **Resume checkout** continues the same attempt. Waffo renews authentication without creating a new session.
- **Change plan** requests abandonment of that attempt. The plan table unlocks only after the server closes it.
- Page entry, browser return and payment return request a status check. Browser query polling is bounded;
  durable jobs continue independently and show a known waiting deadline or a review state.
- Unknown status displays the order reference and support action. A displayed expiry or a PayPal 404
  is never presented as proof of successful cancellation.

The existing selected plan and billing interval stay in the plan table while recovery runs. After
closure, the customer chooses a payment method for a fresh attempt; no second payment starts automatically.

## PayPal

New subscription intents persist `MERCHANT` activation mode and a fingerprint of the environment,
client and webhook configuration **before** creating the PayPal resource. Create requests use
`application_context.user_action = CONTINUE`. PayPal's documented contract requires merchant
activation after buyer approval. Existing intents without this metadata retain `LEGACY` semantics;
create retries cannot silently change their original activation mode.

An unactivated merchant attempt can be abandoned under the same owner lock as checkout admission.
This closes the local attempt and revokes EzPic activation, including when an old browser tab later
approves or returns. It does **not** claim to revoke the external approval URL. Before releasing the
lock, the transaction checks subscriptions and already-received financial receipts.

Activation requires an authenticated provider read matching subscription ID, `custom_id` and plan,
followed by a persisted activation claim under the owner lock. Only an `APPROVED` attempt can activate.
The worker posts to the same resource with a stable request identity, then reads back. Activation
timeouts remain fenced; cancellation cannot erase an uncertain activation claim. Browser parameters
cannot prove approval, supply a provider resource ID, or grant credits. Credits still require the
existing verified payment lifecycle.

Historical automatic attempts cannot be locally reclassified as merchant controlled. A 404, unknown
deadline or unapproved legacy resource remains unresolved until provider closure can be confirmed.
The reported production order was inspected read-only; it was not canceled or rewritten.

## Waffo

New subscription sessions request `expiresInSeconds: 900`; persist the **returned session expiry**.
Session and authentication-token deadlines are independent. Token renewal uses `auth.issueSessionToken`
for the trusted product and buyer identity, replacing only the original URL's token fragment.

Recovery queries the exact merchant external ID within the configured store. When requested, it
cancels a pending order only after checking payment history, then reads the same order back. A canceled
order does not revoke the original checkout session: recovery waits for its verified deadline too.
Closure requires no successful/active/in-flight payment, no ambiguous orders and an expired bound
session. Missing history, partial queries, changed order IDs and pending payments stay fenced.
Lost subscription creates and historical unverified deadlines cannot be cleared by a 24-hour timer.

The installed SDK exposes no checkout-session revoke/read endpoint in its authenticated GraphQL
schema. This implementation therefore does not advertise instant Waffo link revocation. Already
active subscriptions continue through the existing Billing cancellation workflow.

## Persistence and delivery

Migration `20260918155111_subscription_checkout_recovery` adds nullable JSON recovery metadata.
Prisma and PostgreSQL/MySQL/SQLite Drizzle schemas are aligned; both query implementations share the
same recovery state machine. No historical mode or expiry is backfilled by guesswork.

Protected refresh/cancel/resume routes enforce user ownership or organization billing-owner rights.
Each recovery request atomically persists a sequence and an Outbox record. Optional immediate
`dispatchJob` only reduces latency. `SUBSCRIPTION_CHECKOUT_RECOVERY` dispatches
`media-recover-subscription-checkout`; the hourly subscription reconciler recovers interrupted work.
Each delivery sequence completes once, with a 90-second lease and conditional completion. Three
unknown results enter review; repeated approval/activation confirmation is bounded. An actual session
deadline can schedule a later check. Owner locks serialize activation, closure and new admission.

Review metadata retains `PROVIDER_PENDING` for a bound attempt so delayed verified payments can still
use the existing lifecycle processor. Unexpected payments for an already canceled attempt remain
retained by the existing event failure/review path rather than granting duplicate rights.

## Verification and release boundary

Regression checks cover stale leases, cancellation during inspection, activation/abandonment races,
duplicate delivery, paid receipts before closure, tenant access, token-only renewal and payment history.
The migration and concurrent-admission checks use an isolated PostgreSQL 17 database on port 55432.

Sandbox observations on 2026-09-18:

- PayPal create without buyer login returned `APPROVAL_PENDING`; GET found that resource.
  `/cancel` returned 404, and another GET still found `APPROVAL_PENDING`. Therefore cancel-404 is not closure.
- Waffo accepted an explicit 60-second test session deadline. Its token deadline was different.
  Opening the old checkout after expiry displayed “This checkout link has expired”. The merchant
  schema exposed order/payment queries but no checkout-session query or mutation.

These observations do not certify a buyer-approved PayPal `CONTINUE` → activation → paid webhook
round trip. That sandbox buyer check remains **NOT_COMPLETED** without a signed-in sandbox buyer.
No real charge, production-order mutation or production migration is part of these local checks.
Apply the migration before deploying both the site and jobs worker. A Git push alone is not evidence
that either deployment or the reported historical order has been resolved.

References: [PayPal Subscriptions OpenAPI](https://github.com/paypal/paypal-rest-api-specifications/blob/main/openapi/billing_subscriptions_v1.json)
and the installed `@waffo/pancake-ts` 0.19.1 API reference.
