# Guest draft handoff recovery

## Incident boundary

Production records for the November 15 incident show Generate clicked at 21:22:26,
input moderation approved at 21:23:00, and a draft created at 21:23:03 (UTC+8).
The continuation then redirected to `/try?draftError=unavailable` at 21:23:12.
No generation job was created for that input. Its storage reservation and selected
MiniMax H3 1K / auto / PNG settings were consistent when inspected.

The original exception was swallowed. These records establish a failed draft
claim, not its exact database or validation cause. Local PostgreSQL checks of
existing-guest binding succeed; do not describe a missing binding implementation
or a provider failure as the confirmed cause.

## Change

- Claim procedures clear the HttpOnly claim cookie only after success or a proven
  `DRAFT_UNAVAILABLE` outcome. Technical/unknown failures and temporary catalog
  unavailability retain the original credential without extending its lifetime.
- The continuation preserves both handoff cookies on recoverable errors and sends
  the customer to the private, translated `/draft/retry` page. Its retry link
  performs a full request to `/draft/continue`, including the path-scoped cookie.
- Session lookup failures are recoverable too. Invalid, expired, or already
  claimed-by-another-owner drafts retain their existing rejection checks.
- `media.draft.claim.failed` logs the safe error code, stage, elapsed time and
  owner; `media.draft.handoff.failed` identifies the route stage. Neither logs
  the claim token, prompt, private URL, raw SQL or arbitrary exception message.
- A retry uses the same claim and existing owner. It does not upload again,
  invoke a provider, create another anonymous principal, extend expiry, create a
  generation job, or consume credits. Database ownership and replay checks remain
  authoritative, including after a lost commit response.

## Verification and release boundary

Focused API and route tests cover technical failure followed by successful retry,
terminal credential rejection, temporary catalog/session failures and redacted
diagnostics. Isolated PostgreSQL tests cover two reviewed uploads for an existing
guest, concurrent same-claim replay, cross-owner rejection and storage accounting.
A mobile Playwright check renders English and German recovery copy and verifies
that retry navigation sends the original HttpOnly credential. The browser test
stubs the destination response; database correctness is covered separately.

This change requires the website/API bundle, with no migration or jobs/Workflow
change. Local checks do not establish deployment or customer recovery. Existing
credentials already cleared by the old handler cannot be recreated from an
unassociated upload; do not reassign an expired historical draft or generate on
behalf of an unidentified visitor.
