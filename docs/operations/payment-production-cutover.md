# Production payment cutover

This runbook prepares PayPal and Waffo for live collection on the existing Cloudflare site and jobs
profile. Building locally does not enable payments or prove a live payment/refund cycle.

## Required database release

Apply migrations before deploying code that reads the new fields:

- `20260915000000_subscription_payment_adjustments`
- `20260915010000_payment_reconciliation_checkpoint`
- `20260915020000_payment_environment_provenance`
- `20260915030000_credit_pack_reversal`
- `20260915075642_subscription_refund_termination`

They preserve the immutable credit ledger. Successful subscription refunds and Credit Pack reversals
have stable adjustment IDs. Historical PaymentEvents intentionally retain an unknown environment;
do not label old events as live just to make a check pass.

## Environment and catalog

Keep `BILLING_ENABLED=false` during preparation. New checkout stops on the server; capture of an
existing order, authenticated management, webhooks, Outbox and reconciliation must remain available.
Use `PAYPAL_ENVIRONMENT=live` and/or `WAFFO_ENVIRONMENT=prod` with credentials, webhook configuration
and product IDs from those exact merchant environments. Disable the unused channel completely.
Mixing a live channel and a sandbox channel in the same database is rejected for new purchases.

For each enabled channel, configure six subscription mappings (three plans, month/year) and four
Credit Pack mappings. Verify the actual provider products have the expected USD prices, monthly or
yearly interval, no unexpected trial/setup fee, and cancellation behavior. An ID's syntax and a local
snapshot alone do not establish the external product's configuration.

Subscription BillingPlan metadata must include `version: 1`, `planId`, `interval`,
`billingPricingVersion: "2026-09-15.1"`, and the exact `providerEnvironment`. Credit Pack metadata must
include `version: 1`, `productKind: "CREDIT_PACK"`, `packKey`, the pack catalog/pricing versions,
`expiryMonths: 6`, and `providerEnvironment`. Prices/allowances must match the server catalog exactly.
Create new immutable snapshots for new provider IDs; never overwrite an old purchase's terms.

Generate a reviewable manifest from an explicitly selected environment (does not write to the DB):

```powershell
node node_modules/dotenv-cli/cli.js -e .env.production.local -- node node_modules/tsx/dist/cli.mjs packages/api/scripts/billing-preflight.ts --manifest
```

Legacy sandbox subscription snapshots using image `pricingVersion` remain compatible only while all
product, price, currency, interval and allowance fields match. Image repricing no longer disables an
unchanged subscription. Live snapshots always require explicit environment provenance.

## Test-data isolation

The runtime rejects live checkout when this database contains PayPal/Waffo events or used BillingPlan
snapshots whose environment is unknown or non-live. This includes old test credits, refund debt and
pending recurring approvals that would otherwise survive a simple environment-selector change.

Use a dedicated production business dataset, or perform an explicitly reviewed data-isolation
migration preserving existing identities/assets and immutable financial history. Keep the test ledger
in its original database. Do not delete ledger entries, clear balances by SQL, relabel sandbox
transactions as real payments, or locally close an approval that the provider can still charge.
The preflight never makes these changes itself.

## Webhooks and reconciliation

Register the existing `POST /api/webhooks/payments` URL on the canonical HTTPS origin in each
merchant dashboard. The handler selects PayPal, Waffo or Stripe using exactly one recognized
signature header. Signatures are checked before raw events and Outbox entries are persisted.

PayPal events include subscription activation/cancellation/expiry/payment failure, sale completed,
sale refunded/reversed, and capture completed/refunded/reversed. Waffo uses subscription lifecycle,
`subscription.payment_succeeded`, `order.completed`, `refund.succeeded` and `refund.failed`. A failed
refund records no credit mutation. Ensure the merchant registrations include the relevant events.

Scheduled reconciliation reads authenticated notification history, including failed HTTP deliveries,
with a persisted fixed window, pagination cursor, lease and one-day overlap. It resumes incomplete
pages without advancing the watermark on failure. The hourly maintenance task dispatches each
provider independently. Each provider task reads at most two pages and immediately dispatches the
next bounded continuation from its persisted window/cursor, rather than waiting another hour.
Signed retries may resume failed reconciliation tasks; generation submission restart remains fenced.
Preflight requires a completed sweep within the last 90 minutes and no checkpoint error.
This does not reconstruct transactions for which the provider never produced a notification.
A history gap exceeding 30 days stops with
`PAYMENT_RECONCILIATION_HISTORY_GAP`; investigate and reconcile historical transactions explicitly.

Previously unsupported verified refund dead letters are requeued once through Outbox only after their
payload satisfies the now-supported contract. Other dead letters and invalid amounts/identities keep
their fences. Monitor failed events and checkpoint freshness; an enabled cron is not proof a sweep
completed. PayPal/Waffo failures do not prevent independent legacy Stripe reconciliation.

## Ordinary renewal cancellation and payment-method changes

Apply `20260915102451_subscription_cancellation_confirmation` with the existing reviewed migrations
before publishing this version. The migration adds nullable confirmation/request/error fields and
does not infer confirmation from old `cancelAtPeriodEnd` flags or rewrite financial history.

The owner-authorized cancellation endpoint persists `cancellationRequestedAt` and
`SUBSCRIPTION_CANCELLATION_REQUESTED` atomically. Outbox dispatches
`media-confirm-subscription-cancellation`; provider network calls run outside database transactions.
The worker validates the original checkout binding and verified payment-event environment, inspects
the PSP, requests cancellation if still renewing, then inspects again. Waffo `canceling`, timeouts,
unknown results and HTTP success without terminal evidence remain unconfirmed. Retry failures are
stored as sanitized `cancellationError` codes. The hourly sweep requeues exhausted deliveries
without resetting live leases and inspects ambiguous legacy cancellations.

`renewalDisabledAt` is set only from a verified terminal lifecycle event or authenticated terminal
inspection. It survives local expiry and fences later activation/renewal callbacks on that contract.
Unexpected unseen payments after closure retain their verified event in financial-review dead letters;
review the PSP transaction and compensate as appropriate, without restoring old rights or creating
duplicate grants. Ordinary cancellation does not reverse credits, stop prepaid annual monthly grants,
or shorten an already recorded paid period. Switching either way between PayPal and Waffo requires
confirmed closure and paid expiry. Pending requests and locally expired contracts without confirmation
block all new monthly/yearly plans, but do not block Credit Packs.

For historical rows without trustworthy merchant provenance, inspect `cancellationError` and
reconcile the original merchant receipts. Do not backfill confirmation from the date or flag alone.
Monitor cancellation age, errors and Outbox dead letters. A local test or successful code push does
not prove production migrations, cron delivery or live merchant cancellation.

## Full refund termination and financial review

The latest fully refunded PayPal/Waffo subscription payment queues
`SUBSCRIPTION_REFUND_TERMINATION` in the same transaction as credit revocation/debt accounting.
`media-terminate-refunded-subscription` inspects the original contract, requests cancellation when
renewal is still enabled, and inspects again. A successful HTTP response alone is not confirmation.
The verified refund's environment must match the configured merchant environment; unknown or
mismatched provenance remains blocked for review and is never silently relabeled.

PayPal `CANCELLED`/`EXPIRED` and Waffo `canceled`/`closed` confirm closure. Waffo SDK 0.19.1's
`docs/api-reference.md` defines `canceling` as PSP cancellation initiated; it is still reactivatable.
It therefore remains pending until the authenticated order query confirms closure. If the provider
only finalizes closure at period end, that provider delay still applies; the app adds no extra wait.

Pending termination removes paid access but blocks replacement subscription checkout. Confirmation
records `refundTerminatedAt` without rewriting the historical paid-through dates. After confirmation,
the owner can immediately buy a new monthly/yearly plan via either channel. Ordinary cancellation
without a full refund keeps the paid period and the original admission deadline. Credit Packs remain
repeatable, and new grants repay outstanding refund debt first.

Outbox acknowledges only after finalization. Failed deliveries retry with backoff, and the hourly
subscription sweep requeues exhausted or incorrectly acknowledged pending termination deliveries.
Verified closure callbacks also wake inspection without overriding an active delivery lease.
Monitor `refundTerminationError`, pending termination age, and Outbox dead letters. The preflight
reports `refund_terminations_confirmed=false` while any termination is pending. A missing/mismatched
contract or unknown environment requires operator investigation; never set confirmation fields by
hand to open checkout. The same sweep upgrades previously processed latest full refunds on still-open
subscriptions, using their persisted adjustment and verified environment without repeating credit
mutations. Unknown historical environments stay pending for operator investigation.

Termination fences both pending and completed old subscriptions. Old lifecycle/payment replays do
not restore benefits. A new payment ID on such a subscription is retained as a verified PaymentEvent
dead letter with `PAYMENT_PROVIDER_TERMINATED_SUBSCRIPTION_PAYMENT_REVIEW_REQUIRED` and an audit
entry. Review that receipt in the original merchant environment, confirm the amount and actual
charge, resolve renewal closure, and perform any authorized compensation/refund through the payment
provider. Preserve the event and link the operator action in the audit trail. Do not grant credits,
reactivate the old subscription, or mark the event processed merely to clear the launch check.

## Checkout recovery limitation

The pricing page exposes the owned pending checkout link and a provider status refresh. Admission is
released only after provider-confirmed closure (or a local intent that never contacted the provider).
PayPal's cancel-subscription API supports ACTIVE/SUSPENDED subscriptions, not APPROVAL_PENDING.
An unapproved PayPal subscription must remain fenced while its original approval can still succeed;
do not promise an immediate plan/provider switch or expire it locally to bypass this limitation.

## Preflight and launch evidence

Run the read-only preflight against the intended production environment:

```powershell
node node_modules/dotenv-cli/cli.js -e .env.production.local -- node node_modules/tsx/dist/cli.mjs packages/api/scripts/billing-preflight.ts --check-provider
```

It checks selectors, credential presence, all ten mappings per provider, migrations, exact immutable
snapshots, test-data isolation, recent reconciliation and unresolved payment/deadline states. Optional
provider reads do not charge, cancel, refund, or send webhooks. Output contains check names/counts,
not credentials or customer data. Exit 1 means not ready for a live smoke test.

After local validation and environment preparation, deploy through the existing
[Cloudflare profile workflow](cloudflare-workers-profiles.md), preserving site/jobs configuration
and database consistency. Publishing this repository's main branch triggers deployment; keep that
publication step explicit. Observe the scheduled reconciliation on the deployed release.

Before public collection, record a controlled live payment for each enabled channel, verified raw
event, Outbox processing, matching subscription/pack grant, metered consumption, cancellation,
partial/full refund and debt/release behavior, together with the deployment SHA. Exercise annual
boundaries, renewal failures and event ordering in the provider sandbox or controlled test environment;
label that evidence separately from live transactions. Monitor the first actual automatic renewal
after launch and leave that item pending until it occurs; prelaunch validation does not prove a
future renewal. Production payment certification remains `NOT_COMPLETED` until the required initial
live payment/refund checks exist. Enable collection only after the required merchant setup and
prelaunch evidence have passed.
