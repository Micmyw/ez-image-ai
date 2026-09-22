# Pending subscription checkout recovery

Implemented 2026-09-19. Opening checkout may create a provider resource before buyer login.
It is not payment evidence. This flow uses existing PostgreSQL admission locks, immutable checkout
intent identities, Outbox delivery and the verified payment-event ledger pipeline.

## Customer flow

- **Resume checkout** continues the same attempt. Waffo renews authentication without creating a new session.
- **Change plan** requests abandonment of that attempt. The plan table unlocks only after the server closes it.
- Page entry, browser return and payment return request a status check for recoverable attempts.
  `REVIEW` only polls the local status every 30 seconds, so it can observe administrator closure
  without restarting recovery. The hourly sweep also skips `REVIEW` and `PAID`. An explicit customer
  status check can retry review after its cooldown, retaining the failure/check history. Confirmed
  `PAID` status stays intact while ledger fulfillment completes.
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

Historical automatic attempts cannot be locally reclassified as merchant controlled. A 404 or unknown
deadline never unlocks them automatically. Provider-confirmed closure uses ordinary recovery; the
narrow missing-resource case can instead receive the explicit reviewed decision described below.

## Reviewed legacy PayPal closure

Administrators can open `/admin/media#checkout-review` and load the customer's order reference.
The read-only snapshot shows the account reference, plan and whether the historical attempt can be
reviewed. Customer refresh/cancel APIs do not expose this operation.

1. Verify the customer confirms **no subscription approval or payment authorization**, and review the
   merchant's PayPal subscriptions and transactions. If approval, payment or an active subscription
   exists, use billing reconciliation instead. Preserve the support case and merchant review notes.
2. Load the order, enter the case reference and reason, and attest to both checks. The server uses
   the authenticated administrator's identity; client-supplied provider evidence is rejected.
3. Submission rechecks PayPal using current authenticated credentials. The persisted plan environment,
   original approval URL host and any stored scope must agree with the current environment. The exact
   original plan must remain accessible to those credentials. The exact subscription GET must return
   PayPal's `RESOURCE_NOT_FOUND` / `INVALID_RESOURCE_ID` response. This is an observation, **not proof
   of cancellation**. Missing provenance, changed provider status, network errors or approval retain
   the lock.
4. The serializable database transaction takes the provider resource and owner locks, checks the
   loaded `updatedAt`, requires fresh evidence (under two minutes), and rereads eligibility and billing
   records. Only bound `LEGACY` attempts in recovery `REVIEW` after at least three unknown results,
   with the latest reason `RESOURCE_NOT_FOUND`, qualify. Activation claims, active leases, order/payment bindings, purchases, overlapping
   subscriptions and received approval/financial events block closure.
5. Successful resolution retains original provider identifiers, marks the local intent `CANCELED` and
   recovery `CLOSED`, clears its approval URL and active scope, and creates
   `PAYMENT_CHECKOUT_MANUALLY_CLOSED`. Audit metadata records the actor, reason, evidence reference,
   previous state, fresh provider observation, attestations and **`providerConfirmed: false`**. The
   persisted operation identity allows the same decision to be retried without another audit record.
   Stale snapshots or changes to replay evidence are rejected. No subscription, payment or credits
   are created or changed by this operation.

The customer's local-status polling discovers closure; they can then choose a new checkout, subject
to the existing account-wide subscription admission rules. A late payment on a manually closed
legacy attempt stays in the existing payment-event review path; operators must reconcile it rather
than silently grant another subscription or ignore the charge.

No additional migration or environment variable is required for this follow-up. The one-off
production repair authorized on 2026-09-22 was performed separately with an audited operator
decision; it did not certify PayPal cancellation. This code change does not deploy itself.

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

The 2026-09-22 follow-up was also checked on an isolated PostgreSQL 16 database: stable review/paid
states, concurrent idempotent closure, one replacement checkout, stale-snapshot rejection, received
approval/payment guards, and Prisma/Drizzle parity. Focused browser checks use real local sign-in
with fixture payment responses; they cover required administrator evidence, retry identity, desktop
and mobile layouts, read-only customer polling and the resolved state. These are not live PayPal
buyer-payment checks.

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
that either deployment has completed. The separate operator repair is not evidence that these
follow-up changes are live.

References: [PayPal Subscriptions OpenAPI](https://github.com/paypal/paypal-rest-api-specifications/blob/main/openapi/billing_subscriptions_v1.json)
and the installed `@waffo/pancake-ts` 0.19.1 API reference.
