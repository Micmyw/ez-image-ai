# Waffo test payments

EzPic uses the existing provider registry, authenticated checkout procedures, PostgreSQL
payment events, Outbox, and immutable credit ledger. Waffo test credentials and test products
must remain separate from production configuration.

## Local configuration

Keep the following server-only values in the ignored root `.env.local`:

```dotenv
WAFFO_ENVIRONMENT="test"
WAFFO_MERCHANT_ID="MER_..."
WAFFO_STORE_ID="STO_..."
WAFFO_PRIVATE_KEY="..."
WAFFO_WEBHOOK_PUBLIC_KEY="..."
WAFFO_PRODUCT_ID_CREATOR_MONTHLY="PROD_..."
WAFFO_PRODUCT_ID_CREATOR_YEARLY="PROD_..."
WAFFO_PRODUCT_ID_ULTIMATE_MONTHLY="PROD_..."
WAFFO_PRODUCT_ID_ULTIMATE_YEARLY="PROD_..."
WAFFO_PRODUCT_ID_STUDIO_MONTHLY="PROD_..."
WAFFO_PRODUCT_ID_STUDIO_YEARLY="PROD_..."
WAFFO_PRODUCT_ID_CREDITS_1500="PROD_..."
WAFFO_PRODUCT_ID_CREDITS_3000="PROD_..."
WAFFO_PRODUCT_ID_CREDITS_5000="PROD_..."
WAFFO_PRODUCT_ID_CREDITS_8000="PROD_..."
```

The merchant private key signs API requests. The Waffo **test public key** verifies incoming
notifications; it is not the merchant key's public half. The installed SDK accepts PKCS8 PEM
or its base64 body. Never put private keys in `NEXT_PUBLIC_` variables, tracked files, or logs.

For this local setup, `.env.test.local` points to the separate `ezpic_waffo_sandbox` database
on the existing loopback PostgreSQL service. All 43 existing migrations were applied to that
new database. The original `ezpic` database and its migration baseline were preserved.
The test configuration enables billing and disables media generation.

Start from the repository root with:

```powershell
node node_modules/dotenv-cli/cli.js -e .env.test.local -e .env.local -- pnpm --filter saas exec next dev --webpack -H localhost -p 3000
```

Next.js does not automatically select `.env.test.local` during `next dev`; load it explicitly.
Call the dotenv CLI through Node on this Windows/pnpm installation: wrapping it in `pnpm exec`
can consume the argument separator and drop the child command's options.
Provider availability requires configured credentials, product IDs, and an exact active
`BillingPlan` snapshot. `BILLING_ENABLED=false` blocks new subscription and Credit Pack checkout
on the server. Existing payment capture, webhooks, cancellation, refunds and reconciliation continue.
See [production payment cutover](payment-production-cutover.md) before selecting `prod`.

## Products and billing snapshots

Use only test versions (`hasProdVersion: false`) for this setup. Product amounts and intervals
must match the current server catalog and immutable `BillingPlan` snapshots:

| Plan or pack              | USD price | Credit entitlement                    |
| ------------------------- | --------- | ------------------------------------- |
| Pro monthly / yearly      | 19 / 190  | 700 each month                        |
| Ultimate monthly / yearly | 49 / 490  | 1,800 each month                      |
| Max monthly / yearly      | 79 / 790  | 3,000 each month                      |
| 1,500-credit pack         | 59        | 1,500; 1,800 for an active subscriber |
| 3,000-credit pack         | 109       | 3,000; 3,600 for an active subscriber |
| 5,000-credit pack         | 169       | 5,000; 6,000 for an active subscriber |
| 8,000-credit pack         | 259       | 8,000; 9,600 for an active subscriber |

Public plan names Pro and Max correspond to the stable internal keys `creator` and `studio`.
Annual subscriptions grant credits monthly. Packs expire after six months. Existing plan
snapshots are immutable: resolve mismatches by provisioning a new product/snapshot version.

## Webhook and local processing

Register an HTTP webhook in the same store with `testMode: true`, targeting the HTTPS public
address of the existing `POST /api/webhooks/payments` endpoint. Subscribe to:

```text
order.completed
subscription.activated
subscription.renewed
subscription.recovered
subscription.payment_succeeded
subscription.canceling
subscription.uncanceled
subscription.canceled
subscription.past_due
refund.succeeded
refund.failed
```

Preserve the raw request body and `X-Waffo-Signature`. The ingress verifies the RSA signature,
test environment, and store before persisting an event and its Outbox entry. An unsigned
request returns HTTP 400; a verified persisted event returns HTTP 204. HTTP 204 confirms
durable receipt, not completed credit fulfillment.

Waffo deduplication uses `eventType + eventId`. The payment receipt carries a payment ID and
amount but can omit billing dates. Activation, renewal, and recovery notifications supply
authoritative dates. A receipt arriving first waits through the existing correlation-retry
path; it must not invent a billing period or undo a cancellation.

Normal hosted processing uses `media-process-payment-event` through the existing Workflows
dispatcher. Local verification may deliver the isolated test database's Outbox through the
same job handler. Scope any manual pump to the intended test owner and checkout intents;
never sweep the ordinary development or production database. Do not describe a local pump
as verification of the live Cloudflare scheduler.

A temporary tunnel should expose only the webhook route. Remove the exact temporary webhook
registration when stopping its tunnel; preserve other store webhooks. A repeat local test
needs a running app, a new reachable webhook registration, and payment-event processing.

## Verification and current limits

Use a local test account with a non-deliverable address and authenticate through Better Auth.
Create checkouts through the app's existing procedures, which freeze product, owner, amount,
and entitlement before requesting Waffo checkout. Never grant credits from the return URL.

The Waffo sandbox's **Visa → Success** quick-fill uses `4576 7500 0000 0110`; the documented
decline card is `4576 7500 0000 0220`. Use a future expiry and any three-digit CVC. Confirm the
checkout explicitly displays test mode before submitting.

Verification should cover payment success, signed notification receipt, completed intent,
subscription state, exact credit lots, cancellation, and replay without additional grants.
Unit/database scenarios also cover a receipt preceding activation or renewal and delayed
receipts after cancellation. Time-based renewal and recovery require separate live evidence.

Verified successful Waffo refunds use the shared refund reducer to revoke the original credit
grant, record debt for consumed credits, and queue subscription termination after the latest
payment is fully refunded. A failed refund does not change credits. Uncorrelated or invalid
refunds remain fenced for review. Customer portal and seat changes are not supported.

For a merchant-authorized sandbox refund, query the original order and payment first. Verify
the store, buyer identity, product, `testMode: true`, succeeded payment, amount and currency.
Submit `POST /v1/actions/refund-ticket/create-ticket` using **merchant RSA-SHA256 authentication**,
with the original `paymentId`, a reason, `requestedAmount: { amount, currency }`, and a stable
`refundTicketMerchantExternalId`. Waffo auto-approves merchant requests into `processing`; this
is not refund completion. The installed SDK 0.19.1's `customer.createRefundTicket()` uses a
customer bearer token and returned HTTP 403 `Access denied` during the hosted test below.
Use the documented merchant authentication path, not that customer helper, for this operation.
Never print authentication headers or keys.

Before resubmitting after an uncertain response, query the ticket by the exact merchant reference
and inspect the payment's refunds. Confirm provider `refund.succeeded`, the verified PaymentEvent,
completed credit adjustment, matching credit lot/ledger totals, and the termination Outbox state.
The account-wide debt gate blocks generation while debt remains; later grants repay debt first.

Waffo's normal active-subscription cancellation becomes `canceling` until the paid period ends.
Although `willRenew` can already be false, this state can normally be reactivated. EzPic therefore
does not mark final closure from that flag alone: refunded benefits end immediately, but replacement
monthly/yearly checkout remains blocked until `canceled`/`closed` is confirmed. Other open PayPal
or Waffo subscriptions also continue to block checkout. Credit Packs remain repeatable.
See [full refund termination](payment-production-cutover.md#full-refund-termination-and-financial-review).

### Hosted sandbox evidence (2026-09-15)

On deployed revision `e0002b5`, the selected existing Ultimate monthly test order had one succeeded
USD 49.00 payment and one 1,800-credit grant, with 1,765 unused and 35 consumed. The merchant-signed
full refund succeeded. The production webhook accepted the signed test notification, and the hosted
worker processed it automatically: one 1,800-credit refund adjustment removed the remaining 1,765
credits and recorded 35 debt. The account, lots, reservations and immutable ledger passed the credit
invariant check. The refunded Waffo plan stopped supplying benefits; the account's two PayPal test
subscriptions were preserved. Monthly/yearly checkout displayed provider-specific blockers, while
both providers' Credit Pack buttons remained available.

Waffo still reported `canceling` and `willRenew: false`, so final closure and replacement checkout
were not completed in this test. This used a historical payment, not a new checkout; it does not
certify fresh subscription payment, automatic renewal, partial refunds, or a live merchant charge.
Sandbox evidence does not enable production payment credentials or certify live collection.

## Official references

- [Authentication](https://docs.waffo.ai/api-reference/authentication)
- [TypeScript SDK](https://docs.waffo.ai/integrate/sdks)
- [Test mode and cards](https://docs.waffo.ai/features/test-mode)
- [Webhook event contracts](https://docs.waffo.ai/api-reference/webhooks)
- [Add a webhook](https://docs.waffo.ai/api-reference/endpoints/webhooks/add-webhook)
- [Create a refund ticket](https://docs.waffo.ai/api-reference/endpoints/refunds/create-refund-ticket)
- [Cancel a subscription](https://docs.waffo.ai/api-reference/endpoints/subscriptions/cancel-subscription)
