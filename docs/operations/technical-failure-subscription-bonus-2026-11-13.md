# Technical-failure subscription credit bonus

Local implementation; no production activation or real payment is established by these tests.

## Contract

- The compensation is extra credits, not a PSP discount. Waffo/PayPal products, prices,
  checkout amounts, purchased period credits and renewal schedules remain unchanged.
- Eligible registered users with no subscription history receive one lifetime offer after
  an owned image input has authenticated, task-bound SeeAPI `nsfw-filter-2` terminal
  `RATE_LIMITED`, `DETECTION_REPORT_FAILED` or `PROVIDER_TIMEOUT` evidence. Missing,
  unknown, rejected/review-required, anonymous and other-owner evidence is ineligible.
- The offer is valid for seven days. A new first-subscription checkout binds the offer
  before expiry using database time. Its verified initial payment honors that frozen
  binding even if the PSP completes later; old/pending checkout attempts are never
  retrofitted and users with an already pending checkout are not offered this bonus. It adds
  floor(first monthly credit allocation / 10) in a separate gift lot. Annual subscriptions
  also receive the bonus only in month one. The gift expires with that first month.
- Stable append-only audit IDs make issue, dismissal and redemption account-wide and
  idempotent. Checkout eligibility uses the binding receipt, not application/PSP clock
  comparisons. No historical quote, plan, purchase or evidence is rewritten. No extra schema
  is needed; these operations use the active Prisma media ledger like the login bonus.
- The payment reducer grants the gift in the same transaction as the initial paid
  allocation, using existing credit-account and immutable-ledger locks. Unpaid activation,
  mismatched payment amounts/currencies and renewals cannot grant it. Gifts do not count
  as purchased credits or payment revenue. Any verified refund/reversal of that payment
  revokes the gift once using the existing refund/debt protocol; a refund does not reset
  lifetime eligibility.
- The input panel requests the offer after terminal technical feedback. Dismissal leaves
  generation untouched. Pricing displays a current offer, including one dismissed earlier.
  Neither the browser nor a typed error message can establish compensation eligibility.

## Rollout

Deploy compatible payment grant/refund consumers and the API/UI first. Then enable
`MEDIA_TECHNICAL_FAILURE_SUBSCRIPTION_BONUS_ENABLED=true` for website/API issuance.
Default is false. Disabling issuance still honors already issued offers and their refunds;
retain consumers through their expiry and financial lifetime. This switch is independent
of `MEDIA_SEEAPI_INPUT_FAILURE_DELEGATION_ENABLED` and never grants moderation permission.

## Verification

The targeted PostgreSQL suite exercises concurrent issuance and duplicate payment events,
both PSP reducers, unverified/mismatched payments, partial-refund replay, annual allocations,
expiry, disabled issuance and owner/guest boundaries. API and UI tests cover authentication,
untrusted input rejection, displayed terms, dismissal and account-scoped reads. Provider
facts in payment tests are local fixtures; no live payment, subscription or refund is made.
