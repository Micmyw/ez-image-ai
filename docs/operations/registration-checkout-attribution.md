# Registration and checkout attribution

Administrators can read order sources at **Admin → Media operations → Order attribution** (`/admin/media#payment-attribution`). The panel shows the latest 20 purchases and 20 checkout attempts, or an exact local order/checkout reference. The financial checkout-review controls retain their existing scope.

## Stored meaning

- `User.registrationAttribution` is the first consented landing snapshot saved once when Better Auth creates a registered user. Email signup, Google/GitHub OAuth, magic-link registration and a guest registering as a new user use the same hook. Logging into an existing account does not backfill its acquisition source.
- `PaymentCheckoutIntent.attribution` freezes the authenticated submitter's registration snapshot and the page that prompted the checkout. For organization billing the server still verifies billing management permission and binds the actual submitter; no client-selected owner is accepted.
- `Purchase.attribution` is copied from the exact trusted checkout intent during PayPal/Waffo subscription or credit-pack fulfillment. The subscription references that purchase. Renewal, duplicate event, cancellation and refund processing retain the original snapshot. Historical Stripe purchases without a trusted intent remain unknown.

These are untrusted analytics observations, not payment or ownership evidence. Source never affects pricing, credits, permissions, payment identity, redirects or fulfillment. The browser's first-touch time is bounded on receipt; registration and checkout recording times come from the server. A subscription row represents the original purchase; its renewal note means later periods inherit that source, not that a new page was clicked for a renewal.

## Browser and privacy boundary

The existing `consent=true` choice gates this optional collection. A separate first-party `ezimage_first_touch` cookie expires after 30 days and subsequent navigation does not overwrite or renew it. Before consent, the initial page can be held in memory only. The cookie is consumed only at new registration and cleared after registration/sign-in. A separate session-only checkout handoff lasts at most one hour, survives the intended pricing/login transition and is cleared on explicit cancellation, successful checkout, logout, account change or withdrawal. Disabled storage leaves the corresponding source unknown and does not block auth or payment.

The server validates all snapshots again. It keeps known same-site route shapes, collapses private resource IDs and organization settings paths, retains only the external referring origin and admits short source/medium/campaign tokens. Query strings, fragments, arbitrary URLs, credentials, email addresses and authentication callbacks are discarded. Only the existing administrator procedure exposes the order snapshots; the customer purchase response omits them. Consent text and the published English/German privacy documents describe the collection and retention.

## Migration and release

`20261008044431_registration_checkout_attribution` adds three nullable JSONB columns, with no backfill and no new tracking service. Apply the migration before releasing code that reads these columns. Review and deploy the site and payment workers from the same release. Existing records remain readable and display unknown sources. Rolling back code is additive-safe; keep the columns and recorded history.

This task prepares the migration and code locally. It does not authorize a production migration, remote push, deployment or main merge.

## Local acceptance

Use fresh loopback-only PostgreSQL fixtures and mock payment events. Focused tests cover consent and URL cleaning, first-touch retention, account separation, actual Better Auth creation/callback hooks, intent idempotency, trusted purchase fulfillment and refund/renewal retention, historical unknowns and administrator access. The focused browser specs use a local seeded administrator and real read endpoint, with no real payment, supplier generation or outbound mail.

The dated verification report records actual results and remaining gaps. Local fixtures do not establish live provider or production rollout acceptance.
