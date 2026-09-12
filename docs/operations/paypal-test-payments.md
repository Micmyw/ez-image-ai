# PayPal sandbox payments

EzPic uses PayPal REST APIs through the existing provider registry, authenticated checkout
procedures, durable payment events, Outbox, and immutable credit ledger. Keep sandbox
credentials, products, plans, webhooks, and database state separate from production.

## Local configuration

Store the following server-only values in the ignored root `.env.local`:

```dotenv
PAYPAL_ENVIRONMENT="sandbox"
PAYPAL_CLIENT_ID="..."
PAYPAL_CLIENT_SECRET="..."
PAYPAL_PLAN_ID_CREATOR_MONTHLY="P-..."
PAYPAL_PLAN_ID_CREATOR_YEARLY="P-..."
PAYPAL_PLAN_ID_ULTIMATE_MONTHLY="P-..."
PAYPAL_PLAN_ID_ULTIMATE_YEARLY="P-..."
PAYPAL_PLAN_ID_STUDIO_MONTHLY="P-..."
PAYPAL_PLAN_ID_STUDIO_YEARLY="P-..."
PAYPAL_PRODUCT_ID_CREDITS_1500="PROD-..."
PAYPAL_PRODUCT_ID_CREDITS_3000="PROD-..."
PAYPAL_PRODUCT_ID_CREDITS_5000="PROD-..."
PAYPAL_PRODUCT_ID_CREDITS_8000="PROD-..."
```

The current local setup also uses `.env.paypal-test.local`, excluded through the repository's
local `.git/info/exclude`. It selects the isolated `ezpic_paypal_sandbox` database on loopback
PostgreSQL, enables billing, disables media generation, and holds the temporary
`PAYPAL_WEBHOOK_ID`. All 43 existing migrations were applied to this new database. The
ordinary development database and the separate Waffo sandbox were preserved.

The webhook ID belongs to the exact registration for this sandbox REST application. It is
required for signature verification and provider availability. Clear it when that registration
is removed; an old ID must not advertise checkout as ready. A new local run needs a reachable
HTTPS listener and a newly registered webhook before starting checkout.

After registering the listener, start the app with the explicit environment override:

```powershell
node node_modules/dotenv-cli/cli.js -e .env.paypal-test.local -e .env.local -- pnpm --filter saas exec next dev --webpack -H localhost -p 3000
```

Next.js does not select this custom environment file automatically. The local setup helpers
provided with the configuration report start the listener, register its temporary webhook,
write the current webhook ID, and start the app together.

## Catalog and billing snapshots

PayPal catalog products do not themselves define a checkout amount. Six recurring plans
carry subscription prices; the four one-time orders use the server's frozen credit-pack
amounts. Seven catalog products represent three membership tiers and four credit packs.

| Plan or pack              | USD price | Credits                               |
| ------------------------- | --------- | ------------------------------------- |
| Pro monthly / yearly      | 19 / 190  | 700 each month                        |
| Ultimate monthly / yearly | 49 / 490  | 1,800 each month                      |
| Max monthly / yearly      | 79 / 790  | 3,000 each month                      |
| 1,500-credit pack         | 59        | 1,500; 1,800 for an active subscriber |
| 3,000-credit pack         | 109       | 3,000; 3,600 for an active subscriber |
| 5,000-credit pack         | 169       | 5,000; 6,000 for an active subscriber |
| 8,000-credit pack         | 259       | 8,000; 9,600 for an active subscriber |

Pro and Max retain the internal keys `creator` and `studio`. Annual subscriptions issue
credits monthly. Packs expire after six months. The configured sandbox plans have no trial
or setup fee, do not automatically collect outstanding balances, and use a payment failure
threshold of one. Review these settings before provisioning any production plans.

Each price mapping must have an exact immutable `BillingPlan` snapshot, including the current
pricing version. Rotate to a new plan/product and snapshot if pricing changes. Never change
an old snapshot to make a historical checkout match new pricing.

## Webhooks and payment verification

Register `POST /api/webhooks/payments` in the same sandbox REST application for:

```text
BILLING.SUBSCRIPTION.ACTIVATED
BILLING.SUBSCRIPTION.CANCELLED
BILLING.SUBSCRIPTION.SUSPENDED
BILLING.SUBSCRIPTION.EXPIRED
BILLING.SUBSCRIPTION.PAYMENT.FAILED
PAYMENT.SALE.COMPLETED
PAYMENT.SALE.REFUNDED
PAYMENT.SALE.REVERSED
PAYMENT.CAPTURE.COMPLETED
PAYMENT.CAPTURE.REFUNDED
```

Forward the raw request body and PayPal signature headers unchanged. Signature verification
uses PayPal's authenticated verification API and the matching webhook ID before persistence.
An unsigned notification returns HTTP 400. HTTP 204 means durable receipt; fulfillment still
requires payment-event processing through the existing Outbox/job path.

Use a Sandbox **Personal** buyer account to approve checkout. Developer credentials and a
sandbox merchant account configure the receiving side; they do not complete buyer approval.
One-time orders additionally require the authenticated owner-scoped capture endpoint after
approval. Redirects must never grant credits.

PayPal can schedule `next_billing_time` at a different time of day from `last_payment.time`.
Validate the monthly or annual calendar dates for PayPal without rewriting either timestamp.
Persist the original bounds for credit expiry and subsequent renewal anchors; Waffo retains
its exact timestamp interval check. Activation alone grants no credits: the correlated sale
event must still match the frozen amount and currency, and duplicate payment IDs cannot
create another grant. Annual purchases retain twelve monthly credit periods.

Orders v2 can omit `create_time` from a successful payer-action response, including an
idempotent replay. The adapter reads the same order's details to recover its original creation
time and expiry. It rejects mismatched or incomplete details and preserves uncertainty instead
of making another order or extending the expiry from the retry time.

Verify subscription payment, one-time capture, signed delivery, exact credit fulfillment,
cancellation, and duplicate replay before claiming payment completion. A local Outbox pump
must be restricted to the isolated test database and intended checkout owners. It does not
certify the production Cloudflare scheduler. Subscription refund notifications currently enter
the explicit review path.

Remove the exact temporary webhook when stopping its tunnel, clear the temporary webhook ID,
and stop all processes created by the local test session. Preserve other applications and
webhooks. Production credentials and deployment are separate setup steps.

## Official references

- [China merchant integration guide](https://www.paypal.cn/portal/developer/integration?feature=standard)
- [China subscription service](https://www.paypal.cn/portal/merchant/recurring-payments)
- [REST credentials and sandbox](https://developer.paypal.com/api/rest/)
- [Subscription products and plans](https://developer.paypal.com/docs/subscriptions/integrate/)
- [Orders v2](https://developer.paypal.com/docs/api/orders/v2/)
- [Webhooks API](https://developer.paypal.com/docs/api/webhooks/v1/)
