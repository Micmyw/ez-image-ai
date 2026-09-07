# EzPic product contract

This document records the public product boundary introduced by EzPic product PR 1 and extended by
the later editor PRs. It is the reference for later product work; the lower-level AI media
foundation remains the implementation base.

## Product identity and configuration

EzPic is a private, prompt-based AI image editor. A deployment can replace the working brand and
public contact details without editing components or email templates:

| Variable                       | Purpose                                                           |
| ------------------------------ | ----------------------------------------------------------------- |
| `NEXT_PUBLIC_SAAS_URL`         | Canonical origin for the public landing and authenticated product |
| `NEXT_PUBLIC_SUPPORT_EMAIL`    | Public support address; omitted when blank                        |
| `NEXT_PUBLIC_SITE_NAME`        | Product name, defaulting to `EzPic`                               |
| `NEXT_PUBLIC_SITE_DESCRIPTION` | Product metadata and descriptive copy                             |

Production deployments must provide their real origins and support address. Repository defaults
use local development URLs or reserved invalid placeholders; no production domain or legal entity
is embedded in the product code.

## Public products, one wallet, and legal SKUs

EzPic exposes nine image-edit products backed by one `EzPic Credit` balance. Credit use is selected
by the exact legal SKU, not by a universal per-image rate:

| Public product key         | Legal SKU                  | Parameters | EzPic Credits |
| -------------------------- | -------------------------- | ---------- | ------------: |
| `image-nano-banana-2-lite` | `nano-banana-2-lite-1k`    | 1K         |             5 |
| `image-nano-banana`        | `nano-banana-default`      | Default    |             5 |
| `image-nano-banana-2`      | `nano-banana-2-1k`         | 1K         |             9 |
| `image-nano-banana-2`      | `nano-banana-2-2k`         | 2K         |            13 |
| `image-nano-banana-2`      | `nano-banana-2-4k`         | 4K         |            19 |
| `image-nano-banana-pro`    | `nano-banana-pro-1k`       | 1K         |            19 |
| `image-nano-banana-pro`    | `nano-banana-pro-2k`       | 2K         |            19 |
| `image-nano-banana-pro`    | `nano-banana-pro-4k`       | 4K         |            25 |
| `image-gpt-image-1-5`      | `gpt-image-1-5-medium`     | Medium     |             5 |
| `image-gpt-image-1-5`      | `gpt-image-1-5-high`       | High       |            23 |
| `image-gpt-image-2`        | `gpt-image-2-1k`           | 1K         |             7 |
| `image-gpt-image-2`        | `gpt-image-2-2k`           | 2K         |            11 |
| `image-gpt-image-2`        | `gpt-image-2-4k`           | 4K         |            17 |
| `image-seedream-4-5`       | `seedream-4-5-basic-2k`    | Basic, 2K  |             8 |
| `image-seedream-4-5`       | `seedream-4-5-high-4k`     | High, 4K   |             8 |
| `image-seedream-5-lite`    | `seedream-5-lite-basic-2k` | Basic, 2K  |             7 |
| `image-seedream-5-lite`    | `seedream-5-lite-high-3k`  | High, 3K   |             7 |
| `image-seedream-5-lite`    | `seedream-5-lite-ultra-4k` | Ultra, 4K  |             7 |
| `image-seedream-5-pro`     | `seedream-5-pro-basic-1k`  | Basic, 1K  |             8 |
| `image-seedream-5-pro`     | `seedream-5-pro-high-2k`   | High, 2K   |            15 |

Every row accepts `image-to-image`, requires an owned private source asset and prompt, and produces
one image. GPT Image 2 1K is a supported seven-credit SKU. `text-to-image`, multi-output quantity, a
SKU from another product, and an unsupported product/SKU/aspect-ratio combination are rejected
during server-side quoting.

Each product owns an independent rectangular parameter matrix. Fixed, resolution-only, and
quality-plus-resolution products do not share a global option table. Their aspect-ratio lists also
remain independent. The client renders only the legal cells returned for the selected public
product instead of constructing combinations from shared quality or resolution arrays. Supported
output format and background controls are non-billable product-local request options; they do not
create SKU cells or alter the quoted EzPic Credit amount.

Public catalog responses contain product labels, SKU labels, legal parameter cells, aspect ratios,
and EzPic Credit amounts needed by the editor. They never contain Kie identity, raw model IDs,
credentials, route costs, routing weights, or raw Provider payloads. The quote freezes the selected
SKU, credits, server-only cost, catalog/pricing version, and route graph before reservation.

`image-fast` and `image-quality` are legacy EzPic keys retained only to interpret historical records
and recover already-accepted attempts. A new retry is migrated to a legal Kie product/SKU instead of
submitting the legacy route again. The legacy keys are absent from the public product configuration,
plans, and new quote candidates. OpenRouter is not used for new image submissions; its adapter may
remain worker-only to retrieve or reconcile historical attempts.

`video-fast` and `video-quality` remain internal catalog entries and stay outside EzPic public
configuration, plans, navigation, SEO, and UI.

Image catalog and pricing contract version: `2026-09-07.2`. Credit Pack catalog, pricing, and
subscriber-eligibility contract version: `2026-09-06.1`.

## Public homepage and anonymous trial boundary

The SaaS `/` route is an upload-first image editor, not a redirect to login. A visitor chooses one
JPEG, PNG, or WebP source image within the server-advertised limit, enters a prompt, and starts the
sponsored Nano Banana 2 Lite 1K trial. That guest path is fixed to product
`image-nano-banana-2-lite`, SKU `nano-banana-2-lite-1k`, one output, and five sponsored EzPic
Credits; it cannot select any of the other eight image products. Prompt suggestions only populate
the prompt field. The complete nine-product matrix, history, assets, subscriptions, and account
settings remain authenticated enhancements.

The browser obtains the guest capability and uses relative same-origin `/api` endpoints to create a
bounded upload intent, PUT bytes directly to private signed storage, and complete the draft. Image
bytes are not base64-encoded through the application server. The completion call can create only the
short-lived guest draft and opaque claim token; it cannot choose a Provider/model, create an
unmetered job, or bypass moderation, sponsored-risk, storage, and admission controls.

The claim token is sent to `/draft/continue` in a hidden top-level POST form and is never placed in a
query string. The same SaaS service bootstraps a temporary anonymous session and continues to `/try`,
where the existing guest generation path owns admission, job creation, moderation, result access,
expiry, and optional account linking.

## Authenticated editor and one-edit lifecycle

The authenticated `/create` workspace accepts the nine public image product keys and only their 20
legal SKU cells. Its source asset must belong to the signed-in user, be an undeleted READY
image, and remain readable under current moderation evidence. The prompt is required and limited to
the same 10,000-character boundary in the client form and server input schema.

Review creates only the existing server-owned `GenerationQuote` and shows the product, SKU
parameters, EzPic Credit amount, and expiry. Changing the source, prompt, model, resolution, quality,
or aspect ratio invalidates that quote. Confirm then uses a stable per-quote idempotency key and the
existing transaction to bind the frozen input snapshot, reserve credits, create the job, and write
its initial Outbox event. Clients never submit Provider/model routes, prices, credit amounts, signed
URLs, or arbitrary remote inputs.

Claimed drafts, `reuseJob`, and asset reuse restore the source image, prompt, product, SKU, aspect
ratio, and eligible edit-session context. A legacy `image-fast` retry is normalized to Nano Banana 2
Lite 1K with `auto`; a legacy `image-quality` retry is normalized to GPT Image 2 2K with `1:1`.
Other stale or mismatched draft cells are normalized only to a legal server-defined matrix cell and
never turned into an arbitrary Provider request. When the current plan does not permit the restored
product, recovery preserves the edit context and opens the upgrade path rather than silently
downgrading. The API independently rejects unavailable products. Expired, missing, cross-owner,
deleted, and otherwise invalid inputs show an explicit error without creating a quote, job, or
reservation.

Job state is recoverable from the URL after refresh. The result panel reports safe progress and
reserved/charged/released credit summaries, delegates cancellation eligibility to the server state
machine, and covers success, ordinary failure, moderation rejection, and cancellation. A successful
comparison uses the exact job-bound input and only an approved job output; both previews and the
download are requested through short-lived owner-authorized signed URLs. No signed URL is sent to
analytics or application logs.

The homepage uses repository-owned UI assets and icon components. It does not represent decorative
examples as Provider output or model-quality evidence.

The public homepage plus the consented editing funnel and read-only admin aggregate boundary are
specified in
[the growth, SEO, and operations contract](ezpic-growth-operations.md). Other locales and every
authenticated route remain outside the search index.

## Private edit sessions and version history

The first confirmed edit creates one lightweight `ImageEditSession` inside the existing atomic job
transaction. That transaction revalidates the signed-in USER owner's undeleted READY root image,
then creates the session, first `GenerationJob`, input binding, credit reservation, and initial
Outbox event together. A failed transaction leaves none of those records behind, and replaying the
same confirmation does not create a duplicate session or job. Historical jobs are not guessed into
sessions or backfilled.

`/edits` and `/edits/[sessionId]` are protected USER-owned surfaces. List, detail, and rename
operations always scope by `ownerType=USER` and the current user ID; cross-owner session, job, or
asset references use a generic not-found/forbidden response without confirming whether the target
exists. Session listing uses a stable `(updatedAt, id)` cursor. The timeline exposes only the real
prompt, stable public product label, SKU/parameter label, EzPic Credits, status, timestamps, and
owner-authorized private thumbnail. It does not expose Provider/model/cost data, object keys,
signed URLs, or raw snapshots. Failed versions remain for audit but cannot be edited again. A
deleted output remains in the timeline as `Asset deleted`; deleting it does not cascade into jobs,
quotes, the ledger, or the session.

**Edit Again** accepts only a SUCCEEDED image-edit job in the current user's session whose exact
OUTPUT binding is undeleted, READY, image MIME, and covered by the latest approved moderation
decision. The child job's source asset is that selected output, `editSessionId` is inherited, and
`parentJobId` points to the selected version. Any older eligible version can be selected, so the
history is a branchable version graph rather than a forced linear chain. Every child still creates
a new server-side quote, text and asset moderation evidence, credit reservation, stable but new
confirmation idempotency key, asynchronous job, and Outbox event. It never reuses the parent's
quote, moderation decision, reservation, or confirmation key. Parent, session, and exact source
output are validated by the server and frozen into the quote's fingerprinted private snapshot.
Confirmation derives the relationship only from that snapshot: the client may omit its parent echo,
but a mismatched child echo or any parent injected into a root quote is rejected. The atomic job
transaction still revalidates current ownership, parent/output eligibility, moderation, and READY
state before binding the version. The internal edit context is not copied into the Job's Provider
input or returned as a raw public snapshot.

Retrying a failed session version uses the existing durable generation-retry workflow and creates a
new Quote, moderation decision, Reservation, Job, and Outbox event. A failed root retries as another
root version in the same session; a failed child retries as a sibling with the same frozen parent.
The retry operation and its fresh Quote checkpoint carry the server-validated private edit context,
while the Job/Provider input retains only the normalized media input. Replay and post-commit recovery
accept only a result Job whose session and parent match that checkpoint; a detached result is rejected.

## Plans

PR 6 introduced the public package contract below. `PLAN_ENTITLEMENTS` supplies these values to both
pricing surfaces and every runtime authorization path; payment-provider configuration derives its
monetary prices from the same entries rather than repeating entitlement numbers.

| Public plan (internal key) | Monthly credits | Concurrent edits | Allowed products            | Max image input | Price                |
| -------------------------- | --------------: | ---------------: | --------------------------- | --------------: | -------------------- |
| Free (`free`, internal)    |              25 |                1 | Nano Banana 2 Lite          |           10 MB | $0                   |
| Pro (`creator`)            |             700 |                3 | All 9 public image products |           20 MB | $19/month, $190/year |
| Ultimate (`ultimate`)      |           1,800 |                6 | All 9 public image products |           20 MB | $49/month, $490/year |
| Max (`studio`)             |           3,000 |               10 | All 9 public image products |           20 MB | $79/month, $790/year |

Monthly credits are granted once per internal monthly credit period. Annual billing changes only
the payment cadence: Pro, Ultimate, and Max receive 700, 1,800, and 3,000 credits per month rather
than an annual lump sum. Unused plan credits expire with their monthly period and do not roll over.
Public pricing opens on annual billing, hides Free, and shows the rounded `-17%` saving produced by
annual prices equal to ten monthly payments.

The API enforces product access, active-job concurrency, and input byte size at exact boundaries and
fails closed under concurrent confirmation. Privacy, private assets, edit sessions/history, and the
existing review-before-confirm workflow apply to every plan. Pricing does not promise priority
queues, unbounded history, bulk operations, an API, or any other unimplemented entitlement.

Free users receive 25 expiring credits per UTC calendar month through the existing Credit Account,
Credit Lot, immutable Ledger, and `createCreditGrant` path. The stable reference key is
`free-plan:user:<userId>:<YYYY-MM>`. The server serializes the operation and suppresses it for both
ACTIVE paid subscriptions and still-valid PAST_DUE grace periods, so concurrent requests, replay,
and legacy paid state cannot create a second or inappropriate Free grant. The browser and checkout
return never issue credits.

Pro, Ultimate, and Max provider plan or product IDs come only from the server environment
variables documented in `.env.local.example`. A missing or malformed ID removes that checkout
selection server-side and the paid CTA reports temporary unavailability before any Provider call. A
matching active `BillingPlan` snapshot must agree with the canonical plan identity, monthly credits,
interval price, currency, immutable row/metadata version `1`, and the deployed pricing version; drift
also fails closed without rewriting history. Because subscriptions reference the snapshot and each
provider/ID pair is unique, every pricing revision must create a new Provider ID and a new
`BillingPlan` row rather than updating the previous row's identity, economics, version, or metadata.
Checkout return waits for the server-owned Webhook projection and restores the saved editor
draft/session only after the expected plan is ACTIVE or still inside its recorded PAST_DUE grace.
Annual billing continues to create the existing monthly internal credit periods without carrying
unused credits into the next period; subscription Webhook replay, cancellation, partial/full refund,
refund Debt, and failed-job releases keep the existing immutable-ledger semantics. Customer Portal
access remains subject to the existing user or organization owner authorization rules.

New subscription checkout is limited to PayPal and Waffo. Stripe is not advertised or accepted for
new purchases; it remains optional only for historical Stripe Webhooks, portal/cancellation,
refund-repair, and reconciliation. When no complete historical Stripe configuration exists, the
Stripe reconciliation branch safely skips while PayPal/Waffo deadline maintenance continues.

## Credit Packs

The public one-time catalog is separate from subscriptions:

|  Pack | Price | Base credits | Paid-subscriber credits | Subscriber bonus | Validity |
| ----: | ----: | -----------: | ----------------------: | ---------------: | -------: |
| 1,500 |   $59 |        1,500 |                   1,800 |             +20% | 6 months |
| 3,000 |  $109 |        3,000 |                   3,600 |             +20% | 6 months |
| 5,000 |  $169 |        5,000 |                   6,000 |             +20% | 6 months |
| 8,000 |  $259 |        8,000 |                   9,600 |             +20% | 6 months |

Credit Pack checkout accepts only PayPal and Waffo. The first owner-scoped Checkout Intent freezes
pack identity, exact amount/currency, base credits, effective paid-subscriber eligibility, 20% bonus,
catalog/pricing/eligibility versions, and six-calendar-month expiry policy. A replay with the same
idempotency key reuses that snapshot instead of re-evaluating price or subscriber state.

Capture and Webhooks persist a verified `PaymentEvent` and Outbox work before fulfillment. The
reducer creates exactly one expiring credit grant and one fulfillment per provider payment; duplicate
or concurrent delivery cannot grant twice. Verified PayPal refund lifecycle facts can automatically
apply the delta to a cumulative proportional reversal target; a full refund targets the full frozen
grant, and already-consumed credits become Debt through the existing immutable ledger. Waffo
`refund.succeeded` and `refund.failed` currently stop in manual `REVIEW` and do not automatically
mutate the Credit Ledger, Purchase, Fulfillment, or adjustment records. Waffo production automatic
Credit Pack refunds remain `NOT_COMPLETED` pending real sandbox payload fields and authenticated,
idempotent lifecycle certification. A Credit Pack never changes the active subscription.

The monetary amounts above are configuration, not a production margin certification. Reviewed Kie
public prices support the current planning inputs, but no real paid execution has certified any of
the 20 SKU cells. The calculation method, evidence status, production prerequisites, and rollback are
recorded in
[`ezpic-pricing-and-margin.md`](./ezpic-pricing-and-margin.md).

## Navigation and indexing

Public navigation exposes Examples, How It Works, Pricing, FAQ, Privacy, Terms, Blog, Changelog,
Contact, Docs, Sign In, and Start Editing on the unified SaaS origin. Authenticated navigation is
limited to Create, Edits, History, Assets, Billing, and Settings. Existing chatbot and video
implementation code may remain, but those entries are hidden from EzPic navigation.

The same-origin sitemap contains exactly `/`, `/pricing`, `/privacy`, and `/terms`. Blog,
Changelog, Contact, and Docs use `noindex, follow` until their content is approved for indexing.
Login, guest workspace, create, history, assets, edits, checkout, settings, and admin stay
`noindex, nofollow`. Legacy locale-prefixed public URLs permanently redirect to their unprefixed
paths; display language continues to come from the locale cookie.

## Security, privacy, and cost impact

- PostgreSQL, the existing immutable credit ledger, generation jobs, Outbox, Provider routing,
  storage, moderation, payments, and administration remain the single existing architecture.
- Inputs and outputs remain private media assets. An image edit requires an owned, ready source
  asset and continues through the existing moderation, authorization, credit reservation, and
  asynchronous job path.
- Client and public catalog contracts cannot select or inspect Providers, model IDs, credentials,
  route costs, signed URLs, or arbitrary remote URLs.
- This pricing revision changes the canonical product/SKU matrix and per-SKU edit costs while
  preserving the configured plan monetary prices and allowances. It does not claim live Kie
  quality, billed cost, generation verification, or production `BillingPlan` synchronization.

## Migration and rollback

Migration `20260825024738_add_image_edit_sessions` adds `image_edit_session` and only nullable
`generation_job.editSessionId` and `generation_job.parentJobId` relations. Both foreign keys use
`ON DELETE SET NULL`; existing jobs remain valid with null values, receive no speculative backfill,
and no historical asset, quote, reservation, ledger, Outbox, or video row is rewritten. The AI
media domain was already Prisma-only: the PostgreSQL/MySQL/SQLite Drizzle schemas do not contain a
canonical media job, asset, credit, or Outbox model, so this migration deliberately does not create
a second, partial shadow media schema or query layer.

Before rollout, back up PostgreSQL and prove the nullable migration on a restored or isolated copy
containing legacy jobs. Deploy schema-compatible application code after `prisma migrate deploy`.
Rollback the application only to code that tolerates the additive nullable columns and table.
Prefer a forward repair; do not drop the session table or columns after they contain data because
that would discard version history. No ledger rewrite is part of rollout or rollback.

## Explicit exclusions

The original PR 1 scope did not include the homepage editor; PR 3 adds the anonymous draft and
original illustrative Before/After experience described above, PR 4 adds the authenticated
single-edit lifecycle, and PR 5 adds private branchable edit sessions. The current product includes
the controlled guest Nano Banana 2 Lite 1K trial described above, but still excludes collaboration,
comments, public sharing, layers/canvas, masks, batch editing, a public generation API, verified Provider
quality claims, Stripe repricing, public gallery/community features, and any second job, credit,
Provider, or storage system.
