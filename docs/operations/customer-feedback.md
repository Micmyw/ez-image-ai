# Customer feedback by email

Feedback uses the existing public `config.supportEmail` (`NEXT_PUBLIC_SUPPORT_EMAIL`). The published Contact page and the user-confirmed address in `docs/plans/2026-09-12-public-seo-remediation.md` identify `support@ezimageai.com`. No address is guessed when configuration is absent.

The generator help row, generation error messages and shared/public footers open the same dialog. Users choose suggestion or bug report, optionally enter their account email and write their message. They can preview the draft, open their email app, or copy the support address. A screenshot must be redacted and attached by the user in their email app. No browser request sends the feedback, and no prompt, image, account details, payment data, error code or request ID is read or added automatically.

The gift uses CSS/SVG only. Its reserved 24-pixel icon sits in a 44-pixel touch target in normal document flow. A single short burst precedes opening; a cancellable 400 ms timer handles missing animation events and is cleared on completion/unmount. Reduced-motion users and the plain error-report entry open immediately. There are no continuous particles or added dependencies.

## Manual reward review

Accepted suggestions or bug reports may receive 100–1,000 credits, with the amount decided by operations. Opening the dialog, sending an email or reporting a duplicate does not automatically create an entitlement. The account email must be verified before any award.

This change implements no reward API, automatic grant, database migration or new administrator permission. The inspected admin routes/UI contain no dedicated feedback grant action. If authorized operations grant tooling is used, it must reuse `createCreditGrant` in `packages/database/prisma/queries/media/credits.ts`, the existing immutable GRANT ledger and a stable per-award `referenceKey`. Record the reviewed submission, recipient, operator and agreed amount; retries must reuse the same reference and payload. Never update balances directly or grant again on a repeated email. The existing grant replay checks reject a changed account or amount for the same reference. No production grants were performed for this feature.
