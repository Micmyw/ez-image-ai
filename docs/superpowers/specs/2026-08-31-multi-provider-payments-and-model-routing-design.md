# Multi-provider payments and model routing design

## Outcome

EzPic supports server-advertised payment choices for PayPal and Waffo Pancake while
retaining Stripe for existing subscriptions. The public landing generator lets a guest
choose an allowed EzPic image-editing product tier and carries that stable product key
through the private guest-draft handoff. OpenRouter is added as a server-only media
provider boundary without bypassing quotes, credit reservations, jobs, private assets,
moderation, or recovery.

## Product assumptions

- “Waffo” means Waffo Pancake Merchant of Record. PayPal is a separate provider.
- The landing page remains upload-first image editing. This change does not add a
  text-to-image mode, arbitrary aspect ratios, multiple outputs, AI prompt enhancement,
  or styles.
- Customers choose an EzPic product tier and a payment provider. They never submit a
  provider price ID, AI provider, provider model ID, raw cost, remote URL, or credential.
- Stripe remains registered for historical lifecycle events even when it is not offered
  for new checkout.

## Payment architecture

### Provider registry

`@repo/payments` exposes a namespaced registry keyed by `stripe`, `paypal`, and `waffo`.
Each provider declares checkout, portal, cancellation, seat, and webhook capabilities.
Callers resolve a provider explicitly; no colliding `export *` functions remain.

The checkout input is `{ provider, planId, interval, idempotencyKey }`. The server maps
that tuple to a server-only provider plan/product ID, loads the matching `BillingPlan`,
and validates its immutable price, currency, credit grant, and product metadata against
the canonical EzPic entitlement before creating a checkout.

An authenticated availability procedure returns only providers whose required server
credentials and matching `BillingPlan` snapshots are present. Missing or partially
configured providers are omitted rather than failing after a customer selects them.

### Persistence and ownership

The schema gains additive provider-aware records:

- `PaymentCustomer`: provider-scoped owner-to-customer mapping.
- `PaymentCheckoutIntent`: provider, owner, billing plan, plan key, idempotency key,
  provider session/order ID, status, and expiry.
- `Purchase.provider`, with subscription identity unique by provider.
- provider-scoped subscription uniqueness.

Existing user and organization Stripe customer IDs remain readable during migration and
are backfilled into `PaymentCustomer`; they are not destructively removed in this change.
Checkout intents provide trusted webhook correlation and prevent concurrent cross-provider
activation for the same owner and plan.

### Webhooks and billing facts

`POST /api/webhooks/payments` remains the only payment webhook path. Routing is based on
mutually exclusive signature headers and successful raw-body verification. A provider
name in JSON is never trusted. Zero or multiple signature candidates are rejected.

Verified PayPal and Waffo events are stored through the existing idempotent
`PaymentEvent` plus Outbox transaction. The worker dispatches by the persisted provider,
normalizes events into provider-neutral billing facts, and applies them with the existing
serializable credit lifecycle. Unknown owners, missing checkout correlation, stale event
ordering, unsupported refunds, or inconsistent amounts go to review/dead-letter and do
not grant credits.

Stripe’s existing reducer and refund repair path remain intact. PayPal and Waffo do not
reuse Stripe-only refund tables.

### Provider-specific behavior

- PayPal uses REST subscriptions and verifies webhooks through PayPal’s verification API.
  It has no assumed generic customer portal. Cancellation is provider-routed.
- Waffo uses `@waffo/pancake-ts` authenticated checkout and SDK raw-body signature
  verification. Its public consumer login page is not treated as an owner-scoped portal.
- Waffo annual checkout is advertised only when annual product metadata and a matching
  annual `BillingPlan` exist; monthly support is not extrapolated to annual behavior.
- Organization seat updates are available only from providers that declare and implement
  the capability. Unsupported seat mutations fail closed.

## Image-provider and landing architecture

### Stable public catalog

The guest capability response advertises allowed public catalog entries such as
`image-fast` and `image-quality`, including product label, description, credits, and
access hint. The landing client submits only one of those keys. Guest-draft admission,
persistence, claim, quote, and authenticated generation revalidate the key; a stale or
forged key is rejected.

The model selector therefore represents EzPic behavior tiers, not vendors. Provider/model
IDs, weights, cost ceilings, route health, credentials, and fallback details remain
server-only.

### OpenRouter adapter

The media provider union, credential resolution, worker registry, static dispatch manifest,
and Trigger tasks gain `openrouter`. The adapter calls `POST /api/v1/images` with a
server-owned model slug, `n=1`, and the owner-scoped signed input reference for image edits.
It strictly accepts one raster base64 result and returns it through the existing untrusted
inline-output validation path.

OpenRouter does not currently document image request idempotency or a reliable image task
retrieve/cancel contract. The adapter therefore reports provider idempotency as unsupported;
transport, timeout, rate-limit, server-error, and malformed responses remain uncertain and
are never blind-retried. Retrieval returns unknown and escalates through the existing manual
reconciliation threshold.

Two versioned candidates are registered with zero production eligibility by default:

- `image-fast` → `sourceful/riverflow-v2.5-fast`, raster JPEG, up to four references,
  conservative catalog ceiling 21,000 micros per output.
- `image-quality` → `sourceful/riverflow-v2.5-pro`, raster PNG/JPEG/WebP, up to ten
  references, conservative catalog ceiling 170,000 micros per output.

Those slugs, capabilities, and maximum listed output prices were confirmed from OpenRouter’s
public model and endpoint APIs on 2026-08-31. They are candidates, not EzPic quality or
production certification. The exact tuples receive static manifest and Trigger task entries,
but route execution additionally requires the normal provider enablement plus a server-only
`MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED=true` gate. Production validation rejects an enabled
OpenRouter provider when that gate is absent. The catalog and pricing versions are bumped.

OpenRouter’s endpoint catalog publishes no maximum execution duration. Its task and HTTP
timeouts therefore use a separate conservative long-running budget and continue to classify
timeouts as uncertain; the actual P95 and platform ceiling remain benchmark gates. Adapter
readiness and static candidate registration are not production route certification.

### Landing interaction

The desktop hero uses one compact generator with source upload, prompt, product-tier cards,
one-output summary, and the primary action. Mobile reorders those sections vertically with
full-width controls and no horizontal overflow.

The source area supports real drag/drop, preview, replacement, and removal while preserving
the server capability’s MIME and byte limits. Submission exposes deterministic stages:
capability check, preparing, upload progress, server verification, handoff, and failure.
Inputs remain intact after a retryable error. Disabled-action guidance states which required
condition is missing.

Raphael’s information hierarchy is a reference only. EzPic does not copy its brand, copy,
assets, social proof, styles, aspect-ratio controls, output count, or unsupported features.

## Security and privacy constraints

- PostgreSQL remains the business source of truth.
- Payment and AI credentials are server-only and never use `NEXT_PUBLIC_` names.
- Raw payment bodies are verified before persistence or business mutation.
- Provider price IDs and AI model IDs are never accepted from browsers.
- Credit grant/reservation/settlement stays immutable and idempotent.
- Media inputs and outputs remain private owner-scoped assets with short-lived URLs.
- Production rejects incomplete provider configuration, mock adapters, and unmetered calls.

## Verification contract

Each behavioral change follows RED → GREEN tests. Required coverage includes provider
registry routing, checkout availability, raw-signature rejection, duplicate events,
provider-scoped identities, lifecycle normalization, unsupported capabilities, OpenRouter
request/response/error classification, public catalog leakage, guest product-key tampering,
drag/drop and retry stages, desktop/mobile layout, and the existing quote/job/credit/media
regressions.

Repository gates are focused tests, `pnpm format`, `pnpm lint`, `pnpm type-check`, relevant
Playwright coverage, and the media E2E harness when Docker services are available. Real
PayPal, Waffo, and OpenRouter sandbox/live calls require user-owned credentials and are
reported separately as `NOT_COMPLETED` until exercised.
