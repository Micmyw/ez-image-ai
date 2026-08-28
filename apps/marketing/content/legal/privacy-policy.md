---
title: Privacy Policy
---

_Last updated: August 28, 2026_

This policy explains how EzPic handles information when you visit the marketing site, prepare an
image-edit draft, use the anonymous Standard trial, create an account, or use the authenticated
editor. It describes the product as it is implemented today. A production operator identity and
jurisdiction-specific contact notice must be supplied before deployment where applicable.

## Information EzPic handles

EzPic handles account and authentication records, subscription and credit-ledger records, product
settings, and operational records needed to create and recover an edit. When you use the editor, the
service also handles the source image, your edit instruction, quotes, generation status, moderation
evidence, and resulting image.

The public homepage can prepare a short-lived anonymous draft containing the source image, selected
edit mode, and instruction. If the anonymous Standard trial is available and you continue, EzPic
creates a temporary anonymous User and Session so it can authorize one private source image, one
instruction, one generation job, and one watermarked preview. The trial uses sponsored credits and
does not create a subscription or payment charge. Outside this trial, authenticated editing starts
only after sign-in, a server quote, and your confirmation.

To enforce the one-trial rule and protect the service, EzPic stores pseudonymous HMAC values derived
from the temporary session, a browser device identifier, the trusted network address, and a
normalized subnet. The HMAC secret is independent of authentication secrets, and the stored values
are not the raw identifiers. This evidence is used only for security, rate limits, replay prevention,
and sponsored-risk controls during the active promotion policy period. It is not derived from the
optional analytics cookie and is not used for advertising.

## Private media and access

Registered source images and results are private account-scoped assets; guest media is private and
scoped to its temporary anonymous owner. They are not published to a gallery. The application
authorizes access by the signed-in account or temporary anonymous owner and uses a short-lived signed
URL when a browser needs to display or download private media. Anonymous trial outputs are
watermarked. Internal storage keys and permanent public URLs are not exposed as product identifiers.

If you sign in or register from an active trial, EzPic creates an expiry-bounded account-link grant
for that trial result before revoking the anonymous Session. The grant lets the registered account
view and download the same watermarked result until its original expiry. It does not transfer
sponsored credits, extend retention, add the result to History, or enable Edit Again.

EzPic may send the minimum necessary edit input to configured hosting, storage, moderation, payment,
and image-processing services so they can perform the requested function. Those services do not own
the EzPic job, credit, or subscription state.

## Analytics consent

Optional product analytics runs only after analytics consent. Funnel events use an anonymous session
hash and controlled values such as plan, public product key, status, credit bucket, and latency
bucket. Analytics payloads reject prompts, file names, email addresses, raw job IDs, cookies, tokens,
private asset or signed URLs, Provider/model details, cost details, and raw Provider responses.

Declining optional analytics does not prevent essential authentication, security, billing, draft, or
editing storage from working.

## Why information is used

Information is used to provide and secure the service; verify ownership; moderate inputs and outputs;
quote, reserve, charge, or release credits; process subscriptions; recover asynchronous work; prevent
abuse; answer support requests; and understand low-sensitivity product funnel performance when
consent has been granted.

## Retention and deletion

Anonymous marketing drafts expire after no more than one hour. Media used by the anonymous Standard
trial—including the source, clean staging bytes, and watermarked result—is access-bounded and
scheduled for deletion no later than 24 hours after the trial job is created. The exact result expiry
is shown in the product. Clean, unwatermarked staging bytes are deleted before the result becomes
available. Expired account-link grants, link intents, bootstraps, and temporary Sessions are removed;
the temporary anonymous User is removed after no retained guest records remain. Expired abuse-rate
buckets and HMAC-only evidence are pruned by the scheduled guest cleanup for the applicable promotion
policy period.

The current registered-product retention configuration targets 30 days for input and output media
and 7 days for failed-job cleanup. Billing, credit-ledger, security, audit, and legal records may need
a different retention period because they support financial integrity, dispute handling, fraud
prevention, or legal obligations.

Deleting or expiring a private asset prevents new access links and schedules the underlying object
for deletion through the existing asynchronous cleanup path. If cleanup is delayed, access remains
expired while deletion is retried and monitored. Backup and infrastructure copies may take
additional time to age out.

## Your choices

You may accept or decline optional analytics from the consent control. Account, subscription, and
media-management controls available in the product can be used to review or delete eligible data.
For an access, correction, deletion, portability, restriction, or privacy question, use the support
channel shown in the product. The response available to you depends on applicable law and on records
that EzPic must retain for security, billing, or legal reasons.

## Security and changes

EzPic uses owner checks, private storage, short-lived access, moderation, idempotent jobs, and
restricted administrative diagnostics to reduce risk. No online service can promise absolute
security. Material changes to this policy will be dated on this page.
