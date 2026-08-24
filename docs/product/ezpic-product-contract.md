# EzPic product contract

This document records the public product boundary introduced by EzPic product PR 1. It is the
reference for later product work; the lower-level AI media foundation remains the implementation
base.

## Product identity and configuration

EzPic is a private, prompt-based AI image editor. A deployment can replace the working brand and
public contact details without editing components or email templates:

| Variable                       | Purpose                                                    |
| ------------------------------ | ---------------------------------------------------------- |
| `NEXT_PUBLIC_MARKETING_URL`    | Canonical marketing origin and cross-application links     |
| `NEXT_PUBLIC_SAAS_URL`         | Authenticated application origin and sign-in/editing links |
| `NEXT_PUBLIC_SUPPORT_EMAIL`    | Public support address; omitted when blank                 |
| `NEXT_PUBLIC_SITE_NAME`        | Product name, defaulting to `EzPic`                        |
| `NEXT_PUBLIC_SITE_DESCRIPTION` | Product metadata and descriptive copy                      |

Production deployments must provide their real origins and support address. Repository defaults
use local development URLs or reserved invalid placeholders; no production domain or legal entity
is embedded in the product code.

## Public and internal product keys

The internal catalog retains all four stable foundation keys so historical jobs and lower-level
Provider/worker code remain compatible. EzPic's public configuration and catalog expose only the
two image-editing products:

| Internal key    | Public label  | Media kind | Accepted input   | Credits |
| --------------- | ------------- | ---------- | ---------------- | ------: |
| `image-fast`    | Standard Edit | image      | `image-to-image` |       4 |
| `image-quality` | Quality Edit  | image      | `image-to-image` |      10 |

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

Catalog and pricing contract version: `2026-08-25.1`.

## Marketing homepage and anonymous draft boundary

The marketing homepage is an upload-first image editor. A visitor must choose a JPEG, PNG, or WebP
source image within the configured public image-size limit, enter a prompt, and select Standard
Edit or Quality Edit. Prompt suggestions populate the prompt field only; they never submit a draft.
The draft API derives the same byte limit from `DEFAULT_PRODUCT_CONFIG`, checks decoded payload
bytes at the exact boundary, and rejects oversized requests before rate-limit, storage, or draft
database writes.

The anonymous request has one public shape:

```ts
{
	productKey: "image-fast" | "image-quality";
	input: {
		kind: "image-to-image";
		prompt: string;
	}
	upload: {
		contentType: "image/jpeg" | "image/png" | "image/webp";
		base64: string;
	}
}
```

`POST /api/media/drafts` creates only the existing short-lived anonymous `GenerationDraft` and its
private source asset. It does not create a quote, generation job, credit reservation, or Provider
request. After draft creation, the browser sends the opaque claim token to the configured SaaS
`/draft/continue` route in a hidden top-level POST form. The token and prompt are never added to a
query string. Real generation starts only after sign-in, server-side quote review, and explicit
confirmation in the authenticated editor.

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

Claimed drafts, `reuseJob`, and asset reuse restore the source image, prompt, and edit mode. When an
active plan no longer permits Quality Edit, recovery preserves the image and prompt, falls back to
Standard Edit, and explains the downgrade. Expired, missing, cross-owner, deleted, and otherwise
invalid recovery inputs show an explicit error without creating a quote, job, or reservation.

Job state is recoverable from the URL after refresh. The result panel reports safe progress and
reserved/charged/released credit summaries, delegates cancellation eligibility to the server state
machine, and covers success, ordinary failure, moderation rejection, and cancellation. A successful
comparison uses the exact job-bound input and only an approved job output; both previews and the
download are requested through short-lived owner-authorized signed URLs. No signed URL is sent to
analytics or application logs.

The homepage uses original repository-owned vector illustrations documented in
`apps/marketing/public/examples/PROVENANCE.md`. They explain edit categories and the comparison UI;
they are not represented as Provider output or evidence of model quality.

## Plans

PR 1 retains the existing plan IDs, credit grants, concurrency, upload entitlements, Stripe price
references, and configured monetary prices. Only the public product entitlements change:

| Plan    | Allowed products               |
| ------- | ------------------------------ |
| Free    | Standard Edit (`image-fast`)   |
| Creator | Standard Edit and Quality Edit |
| Studio  | Standard Edit and Quality Edit |

No Stripe price is created or changed in this PR. Provider benchmarking and the final credit/price
decision belong to later product PRs.

## Navigation and indexing

Marketing navigation is limited to Examples, How It Works, Pricing, FAQ, Sign In, and Start
Editing. Pricing is an English homepage section in PR 1, not a new standalone route. Authenticated
navigation is limited to Create, History, Assets, Billing, and Settings. Existing chatbot and video
implementation code may remain, but those entries are hidden from EzPic navigation.

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
- This PR preserves existing credit amounts and Stripe pricing. It does not claim live Provider
  quality, cost, or generation verification.

## Migration and rollback

There is no database migration. Historical jobs, assets, quotes, and video data are not deleted.

Rollback consists of reverting the EzPic product keys and plan entitlements, catalog labels/input
rules and contract version, navigation and indexing configuration, product copy, and placeholder
brand assets. No ledger rewrite or data migration is required.

## Explicit exclusions

The original PR 1 scope did not include the homepage editor; PR 3 adds the anonymous draft and
original illustrative Before/After experience described above, and PR 4 adds the authenticated
single-edit lifecycle. The current product still excludes anonymous real generation, multi-round
editing, project/version history, masks, batch editing, a public generation API, verified Provider
quality claims, Stripe repricing, public gallery/community features, and any second job, credit,
Provider, or storage system.
