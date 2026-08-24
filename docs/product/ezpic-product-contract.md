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

`video-fast` and `video-quality` remain internal catalog entries. They are excluded from
`DEFAULT_PRODUCT_CONFIG.productKeys`, public catalog responses, plans, navigation, and EzPic user
interfaces. Their existing Provider, worker, storage, moderation, job, and historical-data paths are
not removed or replaced.

Catalog and pricing contract version: `2026-08-25.1`.

## Marketing homepage and anonymous draft boundary

The marketing homepage is an upload-first image editor. A visitor must choose a JPEG, PNG, or WebP
source image within the configured public image-size limit, enter a prompt, and select Standard
Edit or Quality Edit. Prompt suggestions populate the prompt field only; they never submit a draft.

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
original illustrative Before/After experience described above. The current product still excludes
anonymous real generation, verified Provider quality claims, Stripe repricing, public
gallery/community features, and any second job, credit, Provider, or storage system.
