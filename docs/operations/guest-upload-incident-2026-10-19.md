# Guest upload admission failures — 2026-10-19

## Outcome and boundaries

The observed production failures are guest upload admission denials, before an upload session,
generation task, credit reservation, or image-provider request is created. In the fixed 24-hour
window `2026-10-18T15:11:55.247Z`–`2026-10-19T15:11:55.247Z`, the website recorded five successful
upload intents and 40 HTTP 500 responses. All 40 failed requests correlate with
`GUEST_UPLOAD_RATE_LIMITED`; the queries reported sampling interval 1. Only anonymous network
counts were returned: five networks for successful requests and 22 for failures.

Production database buckets contain exactly five committed guest upload admissions on each UTC
day from October 12 through October 19. Requests resume after UTC rollover. This strongly suggests
a restrictive global daily limit of five, but the numeric production settings are secret-text
bindings and their values were not read. The shared error does not identify the rejected bucket;
short-window denials were also observed. Do not attribute every rejection to the daily bucket or
report the source default of 100/day as the running setting.

The patch fixes HTTP error classification and customer feedback. It does **not** increase the
existing admission allowance or establish that previously denied requests can now generate.
Restoring broader guest availability requires an explicit product decision about the production
limit. No limit, safety review, price, shared image/video credit rule, or production configuration
was changed.

See [production evidence](evidence/guest-upload-rate-limit-2026-10-19.md) for request IDs, exact
windows, accepted bucket counts, sampling limits, and the separate completion-query evidence.
The [customer-flow limit audit](customer-flow-limits-audit-2026-10-19.md) covers additional upload,
review, generation, credit, concurrency, storage, and download constraints, separating confirmed
code behavior from unverified recovery candidates. Ordinary images and videos share valid
account credits; this patch adds no separate video quota.

## Checkout and production identity

- `git fetch origin` succeeded. Original worktree `/workspace/ez-image-ai` remained clean on
  branch `work`.
- Local HEAD and fetched `origin/main` both equal
  `174e29ee1576fb1eb907249ed0480e0e9f0f1734`.
- An isolated worktree `/workspace/ez-image-ai-guest-fix` and branch
  `codex/fix-guest-edit-prepare` were created from that `origin/main`.
- The enabled custom domain `ezimageai.com` maps to `ezimageai-site-production`.
  Active website deployment `8690bcc9-30a8-43a7-8717-5e22814673cf` routes 100% to
  version `8476f8d4-6d41-469b-aa8f-a8c612f45c36`.
- Active jobs deployment `581f86cc-28bb-42d7-9bda-40670cf5925d` for
  `ezpic-workflows-workers-production` routes 100% to version
  `75d87d72-8c59-4c78-91ba-98a6e08a85f3`.
- Both active versions' `workers/tag` match the full main SHA above. Production upload error
  logs also carry the same website version and application deployment SHA.

The deployment checks read active traffic assignments and version annotations; they do not rely
on CI status alone. The two Clarity screenshots were read through Library. Their generic guest
preparation error and verification guidance do not individually prove a Turnstile failure or
match a particular request ID.

## Why the code returned 500

`createGuestMediaUploadIntentTransaction` throws an ordinary
`Error("GUEST_UPLOAD_RATE_LIMITED")`. The public procedure previously propagated it as an
unexpected error, which oRPC serialized as HTTP 500. The browser then collapsed every non-2xx
intent response into `GUEST_UPLOAD_INTENT_FAILED`, and `LandingGenerator` showed its generic
"try the upload again" message. Verification refresh callbacks could clear that explanation.

The minimal patch maps only that known transaction error to HTTP 429 /
`TOO_MANY_REQUESTS`, preserves genuine unexpected failures as 500, and does not sign an upload
on admission denial. The client distinguishes HTTP 429 and displays a translated limit/wait
explanation while keeping the current image, prompt, and model. Verification refreshes preserve
upload errors and still clear actual verification errors. No automatic retry was added.

## Limit history and counting

| UTC date            | Commit                                     | Recorded change                                                                                                                     |
| ------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-27 15:47:52 | `5386d5053fee306d96c56d737efd7edff6540f89` | Added initial guest configuration and admission parameters.                                                                         |
| 2026-08-27 17:41:50 | `e8303c30551dd6fc6471232e7866e733f796ff2c` | First enforced `GUEST_UPLOAD_RATE_LIMITED` in private guest uploads.                                                                |
| 2026-08-28 18:07:39 | `fbd7874f499c51fd6a90ebc5e031962a367da87c` | Added the six IP/subnet/global time-window buckets and explicit production configuration.                                           |
| 2026-08-29 03:36:24 | `1cafd79210c4af1fe02d09d4adfd48a3c5407c32` | Added production hard ceilings and cross-promotion global protection.                                                               |
| 2026-09-21 09:43:43 | `1ae93240eb3272744d006f354ccf8d16e995e0fd` | Raised guest/device allowance to two accepted edits per UTC day; IP ten-minute cap became two. Global traffic limits were retained. |
| 2026-09-21 11:40:48 | `05ff2aeadb8fdd0fda6fa51270b499c7fe373f46` | Allowed an uncapped guest cost budget while explicitly retaining traffic, concurrency, verification, and review restrictions.       |

The [original design](../superpowers/specs/2026-08-27-anonymous-standard-raphael-experience-design.md)
documents anonymous-trial abuse and cost protection. The
[follow-up plan](../superpowers/plans/2026-08-29-anonymous-standard-residual-safety-fixes.md)
allows stricter production settings. Neither establishes that the current five-admission plateau
was an intended business requirement. Its setting date and operator were not verified.

The current source defaults and production ceilings are IP 2/ten minutes, IP 3/day, subnet 20/day,
global 3/minute, 30/hour and 100/day. Production requires explicit positive values at or below
these ceilings. Windows are fixed UTC buckets, rather than rolling intervals.

Uploading a file in the UI does not itself call the intent endpoint. One valid submit calls it
once; the synchronous `submissionInFlight` ref blocks duplicate form submission. Explicit Retry
starts a new intent. Accepted intent quota commits before later session/signing/PUT/review work,
so a later failure can consume an upload allowance. A rate-limit denial rolls back its increment
and does not accumulate more accepted quota. Existing zero rejection counters are not evidence
that no denials occurred.

## Regression evidence

- Before the fix: the real OpenAPI regression returned 500 instead of 429; the browser-client
  regression returned the generic error instead of the limit error. Independent original-HEAD
  component replay failed three of four verification-feedback cases.
- After the fix: six relevant Vitest files, **57 tests passed**: 29 API and 28 app tests. Coverage
  includes successful admission, typed 429 denial without signing, genuine DB/signing 500s,
  browser response classification, draft preservation during verification refresh, and existing
  guest verification recovery.
- Changed TypeScript/TSX files passed focused lint; changed source and translation files passed
  formatting and diff whitespace checks. Translation type checking passed.
- The added Playwright scenario is discovered by `--list`; browser execution and a production
  application build were not completed. Prisma client generation failed while fetching the
  official schema-engine checksum from `binaries.prisma.sh` with HTTP 403. API type checking
  therefore remains blocked by the missing generated client and consequent type errors.

No production deployment, database migration, paid generation, or secret read was performed.
