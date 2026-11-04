# PR 56 purchase, recovery and authentication rollout

This note describes release prerequisites, not evidence of a production deployment.

## Database and image-pass offer

Apply `20261104010000_image_pass_offer_1k_2k` to the intended database before deploying new
offer producers. It widens the checkout-intent constraint to accept both offer versions.
It does not rewrite paid grants, pending purchases, ledger entries or reservations. The Git
build's `prisma migrate status` is read-only and stops the build while a migration is pending.
Use the existing reviewed database migration process; merging the PR does not apply this migration.

New offer `2026-11-04.1` covers the explicit standard 1K/2K SKU list. The original
`2026-10-19.1` offer is frozen to its exact price, units and 29 original SKUs, independent of
future catalog additions. Normal paid-subscription access checks still apply.
Rollback must retain a consumer that understands accepted purchases of both versions.
Disabling new intake never deletes grants or automatically refunds uncertain generations.

## Unknown generation and cancellation

For an image attempt without a confirmed task ID, the 30-minute database-time deadline only
escalates investigation. It does not prove rejection, clear uncertainty, settle credits or
release image-pass units. Recheck the deadline and missing identity under the attempt lock.
Confirmed task IDs continue normal recovery. Late Kie callback hints are retained in manual
recovery without binding acceptance or authorizing another submission. Resolve the original
attempt through authenticated evidence or an audited administrator decision.

Post-submission cancel admission and UI capability require a known task ID and a supported
adapter (currently Replicate). Old queued cancellation requests for unsupported adapters release
their cancellation lease and leave the original task's normal recovery intact.

## Better Auth 1.7.7

Upgrade Better Auth and `@better-auth/passkey` together on every instance that shares
verification storage. Avoid serving mixed old/new auth implementations during rollout.
Unused old magic links and in-progress OAuth flows may need to restart. Existing account data
does not require the `Account.issuer` migration from the initial 1.7 prereleases: the requirement
was removed in 1.7.3. Two-factor enrollment now checks `method === "totp"` before using `totpURI`.

References: [1.7 upgrade guide](https://github.com/better-auth/better-auth/blob/v1.7.7/docs/content/docs/guides/1-7-upgrade-guide.mdx)
and [1.7.7 release](https://github.com/better-auth/better-auth/releases/tag/v1.7.7).

Local authentication regression tests exercise the actual memory adapter, reject legacy
cross-purpose verification records and reject magic-link replay. CI owns disposable PostgreSQL
migration/integration checks, browser workflows and production artifacts. None of those checks
certify a real payment, generation or production database migration.
