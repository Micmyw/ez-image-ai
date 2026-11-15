# Customer-first administrator content

The media administration page now starts with one customer directory. Opening a customer shows a single paginated timeline containing uploaded images, generated images, generation jobs (including successes and failures with no assets), and rejected prompt requests without jobs. Image and prompt inspection reuse the existing audited detail readers; cleanup retains its exact selection, preview and confirmation contract.

The directory searches email/name or exact owner/image/task/request IDs and shows aggregate counts. Both directory and customer timeline cover all retained history, with 25-row keyset pages and an explicit older-record action. Timeline filters start with all kinds and outcomes. Changing customers resets filters, pagination, selected images and detail dialogs. Existing global list APIs remain compatible. No financial, provider, ownership, moderation or deletion transition is changed by browsing.

## Guest identity

`guest_upload_<hash>` is derived from the signed browser subject **and upload request ID**. It is an isolated upload owner, not a visitor identity. Better Auth anonymous owners are session principals and likewise need not represent distinct visitors.

New guest upload audits persist the already verified `browserSubjectHash` and `guestBrowserIdentityVersion: 1` atomically with the upload asset/session/reservation. Guest prompt-denial audits capture the same server-verified identity. The browser never supplies this value as a public request field; neither a cookie token nor a signing key is stored. Business owner IDs, stable upload replays, storage boundaries and lifetime trial funding are unchanged.

The administrator reader can recover associations from:

- New upload audit metadata, independent of short-lived upload-session cleanup.
- Retained historical `guest-upload-active:<browser hash>` buckets bound to the exact upload session and asset.
- Exact bootstrap source-asset/anonymous-owner links.
- Permanent lifetime entitlement owner/browser receipts for the same trial.
- Guest prompt-denial records and their exact source assets.

Only unambiguous evidence groups an upload/owner. The response exposes a separate opaque `GUEST_BROWSER` directory identity, not the raw subject hash. A browser group means the same signed browser identity, not a proven human. Cookies cleared, different browsers, conflicting associations, or expired historical evidence can leave records separate; the UI explicitly labels unlinked uploads and guest sessions instead of counting them as distinct visitors. Similar images, prompts, timestamps, IPs and device fingerprints do not establish identity and are not used to merge records.

Completed, unambiguous `GuestLinkIntent` links may associate the exact anonymous owner with its registered account. A shared browser alone never merges registered accounts or establishes registered ownership. These read projections do not transfer assets or authorize generation, storage, payments or trial benefits.

## Privacy and compatibility

New POST routes `/admin/media/customers/search` and `/admin/media/customers/content` enforce the existing registered-administrator guard, append administrator read audits, and disable caching/indexing. Detail requires both customer identity type and ID. Search values remain parameterized and wildcard characters escaped. Lists contain only bounded metadata; private prompt text, original images and provider diagnostics remain behind the existing detail reads.

No database migration or historical business-record rewrite is required: the writer adds fields to existing private audit metadata and the reader supports absent fields. Historical associations are resolved at read time only where evidence still exists.

## Local verification

- PostgreSQL regression uses connection-local temporary tables in the explicitly isolated loopback test database, covering all three content sources, old history, owner-type collisions, browser grouping across upload IDs and anonymous sessions, retained legacy evidence, shared-browser registered isolation, search and tied-cursor pagination.
- Database transaction tests verify the browser association is written alongside the upload audit without changing upload ownership. Prompt persistence and guest-admission regressions verify the server-observed hash is carried only for guests.
- API tests cover unauthenticated/non-admin/anonymous denial, exact-owner requirements, bounded input and private headers. SaaS tests cover the directory, mixed timeline, truthful guest labels and cached-error feedback.
- Chromium component verification uses the real components, translations and CSS with local fixture query responses. It covers directory entry, image/prompt dialogs, pagination, filter reset, issue filtering, customer switching and desktop/mobile presentation. This is not a production/authentication/provider verification. Screenshots are under `output/playwright/admin-customer-*.png`.

No push, deployment, production grouping validation or customer-content deletion was performed by this task.
