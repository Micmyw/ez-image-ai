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
| `NEXT_PUBLIC_MARKETING_URL`    | Legacy compatibility alias; production requires it to match SaaS  |
| `NEXT_PUBLIC_SUPPORT_EMAIL`    | Public support address; omitted when blank                        |
| `NEXT_PUBLIC_SITE_NAME`        | Product name, defaulting to `EzPic`                               |
| `NEXT_PUBLIC_SITE_DESCRIPTION` | Product metadata and descriptive copy                             |

Production deployments must provide their real origins and support address. Repository defaults
use local development URLs or reserved invalid placeholders; no production domain or legal entity
is embedded in the product code.

## Public and internal product keys

The internal catalog retains all four stable foundation keys so historical jobs and lower-level
Provider/worker code remain compatible. EzPic's public configuration and catalog expose only the
two image-editing products:

| Internal key    | Public label  | Media kind | Accepted input   | Credits |
| --------------- | ------------- | ---------- | ---------------- | ------: |
| `image-fast`    | Standard Edit | image      | `image-to-image` |       5 |
| `image-quality` | Quality Edit  | image      | `image-to-image` |      40 |

Both products require a private source asset ID and a prompt. `text-to-image` is rejected during
server-side quoting. Public catalog responses contain fields needed to render the editor, but never
Provider names, model IDs, credentials, route costs, or raw Provider payloads.

The marketing server selects each public label and credit amount from that canonical media catalog
and passes only those two display fields to the client form. Locale messages supply a value-only
credit template; they do not own product labels or credit amounts.

`video-fast` and `video-quality` remain internal catalog entries. They are excluded from
`DEFAULT_PRODUCT_CONFIG.productKeys`, public catalog responses, plans, navigation, and EzPic user
interfaces. Their existing Provider, worker, storage, moderation, job, and historical-data paths are
not removed or replaced.

New image quotes use only the server-side OpenRouter Riverflow fast/pro candidate routes. Historical
Provider adapters and dispatch metadata remain private compatibility paths for already-frozen work;
they are not selectable by the browser and are not candidates for new image quotes.

Catalog and pricing contract version: `2026-09-05.1`.

## Public homepage and anonymous trial boundary

The SaaS `/` route is an upload-first image editor, not a redirect to login. A visitor chooses one
JPEG, PNG, or WebP source image within the server-advertised limit, enters a prompt, and starts the
metered guest Standard Edit. Prompt suggestions only populate the prompt field. Quality Edit,
history, assets, subscriptions, and account settings remain authenticated enhancements.

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

The authenticated `/create` workspace accepts only `image-fast` and `image-quality` image edits.
Its source asset must belong to the signed-in user, be an undeleted READY image, and remain readable
under current moderation evidence. The prompt is required and limited to the same 10,000-character
boundary in the client form and server input schema.

Review creates only the existing server-owned `GenerationQuote` and shows its mode, credit amount,
and expiry. Changing the source, prompt, or mode invalidates that quote. Confirm then uses a stable
per-quote idempotency key and the existing transaction to bind the frozen input snapshot, reserve
credits, create the job, and write its initial Outbox event. Clients never submit Provider/model
routes, prices, credit amounts, signed URLs, or arbitrary remote inputs.

Claimed drafts, `reuseJob`, and asset reuse restore the source image, prompt, and edit mode. When the
current plan does not permit Quality Edit, recovery preserves the image, prompt, Quality selection,
and eligible edit-session context, then opens the upgrade path. It never silently downgrades or
submits Standard Edit. The API independently rejects the unavailable product even if a client
bypasses the interface. Expired, missing, cross-owner, deleted, and otherwise invalid recovery
inputs show an explicit error without creating a quote, job, or reservation.

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
prompt, Standard Edit or Quality Edit label, credits, status, timestamps, and owner-authorized
private thumbnail. It does not expose Provider/model/cost data, object keys, signed URLs, or raw
snapshots. Failed versions remain for audit but cannot be edited again. A deleted output remains in
the timeline as `Asset deleted`; deleting it does not cascade into jobs, quotes, the ledger, or the
session.

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

| Plan    | Monthly credits | Concurrent edits | Allowed products                                      | Max image input | Price                |
| ------- | --------------: | ---------------: | ----------------------------------------------------- | --------------: | -------------------- |
| Free    |              25 |                1 | Standard Edit (`image-fast`)                          |           10 MB | $0                   |
| Creator |             700 |                3 | Standard (`image-fast`) and Quality (`image-quality`) |           20 MB | $19/month, $190/year |
| Studio  |           3,000 |               10 | Standard (`image-fast`) and Quality (`image-quality`) |           20 MB | $79/month, $790/year |

Monthly credits are granted once per internal monthly credit period. Annual billing changes only
the payment cadence: Creator still receives 700 credits and Studio still receives 3,000 credits per
month rather than an annual lump sum. Unused plan credits expire with their monthly period and do
not roll over.

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

Creator and Studio provider price, plan, or product IDs come only from the server environment
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
unused credits into the next period; Webhook replay, cancellation, partial/full refund, refund Debt,
and failed-job releases keep the existing immutable-ledger semantics. Customer Portal access remains
subject to the existing user or organization owner authorization rules.

The monetary amounts above are configuration, not a production margin certification. Published
Provider prices support the current assumptions, but no real billed Provider execution has
certified Standard or Quality routes. The calculation method, evidence status, production
prerequisites, and rollback are recorded in
[`ezpic-pricing-and-margin.md`](./ezpic-pricing-and-margin.md).

## Navigation and indexing

Marketing navigation is limited to Examples, How It Works, Pricing, FAQ, Sign In, and Start
Editing. Pricing is an English homepage section in PR 1, not a new standalone route. Authenticated
navigation is limited to Create, Edits, History, Assets, Billing, and Settings. Existing chatbot and
video implementation code may remain, but those entries are hidden from EzPic navigation.

English is the only indexable product language at launch. The marketing sitemap includes the
default-English homepage and the existing approved Privacy and Terms pages. German, Spanish, and
French infrastructure remains available for later review, but those locale URLs use
`noindex, follow`, are absent from the sitemap, and have no visible locale switch. The complete SaaS
application disallows crawling and uses noindex metadata.

## Security, privacy, and cost impact

- PostgreSQL, the existing immutable credit ledger, generation jobs, Outbox, Provider routing,
  storage, moderation, payments, and administration remain the single existing architecture.
- Inputs and outputs remain private media assets. An image edit requires an owned, ready source
  asset and continues through the existing moderation, authorization, credit reservation, and
  asynchronous job path.
- Client and public catalog contracts cannot select or inspect Providers, model IDs, credentials,
  route costs, signed URLs, or arbitrary remote URLs.
- This pricing revision changes the canonical edit costs and monthly credit allowances while
  preserving the configured monetary prices. It does not claim live Provider quality, billed cost,
  generation verification, or production BillingPlan synchronization.

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
single-edit lifecycle, and PR 5 adds private branchable edit sessions. The current product still
excludes anonymous real generation, collaboration, comments, public sharing, layers/canvas, masks,
batch editing, a public generation API, verified Provider quality claims, Stripe repricing, public
gallery/community features, and any second job, credit, Provider, or storage system.
