# Private prompt context for moderation support

## Scope and storage

Successful quotes and jobs already freeze `inputSnapshot.prompt`. Previously, text denials retained
only the detector evidence/fingerprint, and reference images stopped before quoting could have no
server-side prompt. Historical missing text cannot be reconstructed.

Signed-in image forms now capture nonblank reference-image prompts after a two-second pause,
including while image review is pending, unavailable or rejected. The protected
`POST /media/reference-prompts` endpoint derives the owner from the session, verifies a finalized,
nondeleted image owned by that account, and applies an independent 30-request/minute rate limit.
It appends `MEDIA_REFERENCE_PROMPT_SAVED` to the existing private `audit_log`; no schema migration
is needed. Each capture has an owner-bound stable ID; one bounded browser retry reuses it. Replays
cannot overwrite content or timestamps. Account/image/prompt changes cancel pending browser saves.

`MEDIA_TEXT_MODERATION_BLOCKED` now records the actor, original prompt, public model key and source
asset reference together with the existing moderation observation transaction. It never stores an
upload token, private URL or complete input snapshot in this context. Successful quote/job snapshots
remain unchanged. Pure text drafts that have not been submitted and anonymous browser drafts are
not newly captured by this endpoint; existing guest-draft/job retention continues separately.

Administrator moderation details display up to ten reference captures and ten linked jobs,
separately labeled and with server receipt times. Draft context is diagnostic only: it never becomes
`prompt` evidence for approval/recheck, creates a quote/job, charges credits or permits media access.
Viewing details retains the existing administrator check and access audit. List APIs omit text.
Audit retention and account-erasure
operations remain under the existing operational-record policy; browser draft expiry does not
purge these audit records.

## SeeAPI live smoke test, 2026-11-13

Two existing public site samples (dog photograph and clothed portrait) were inspected and converted
to padded 1568×1568 JPEG, quality 85, matching the production moderation preparation contract.
Each was submitted once to `nsfw-filter-2` with threshold 0.5 and strict special care, without a
production callback. Authenticated GET retrieved each accepted task; no customer job, asset,
moderation evidence or credits were changed.

Both POSTs returned 202/processing; both subsequent GETs returned 200/succeeded with `flagged=false`
and empty `nsfw`/`special_care` arrays. This proves two successful benign-image calls at test time,
not classification accuracy, absence of intermittent rate limits, or recovery of historical tasks.
The local evidence contains task IDs, timestamps, prepared-byte hashes and sanitized results, but
no API key or image data URL. Website code changes have not been deployed by this task.

## Historical failure investigation

Read-only production checks covered nine input assets from the two administrator screenshots.
Every asset has `VERIFICATION_FAILED`, one bound SeeAPI task, one initial PENDING observation,
four ERROR observations and zero related quotes, generation jobs or generation-provider attempts.
The absence checks covered both asset bindings and owner-scoped snapshots.

| Asset suffix prefix | Screenshot time (Asia/Shanghai) | Authenticated SeeAPI task error |
| ------------------- | ------------------------------- | ------------------------------- |
| 78df0238            | 2026-11-10 20:56                | DETECTION_REPORT_FAILED         |
| 49ce5772            | 2026-11-10 16:48                | DETECTION_REPORT_FAILED         |
| 00136793            | 2026-11-09 06:14                | DETECTION_REPORT_FAILED         |
| 28b8e7cf            | 2026-11-09 06:09                | DETECTION_REPORT_FAILED         |
| ee989592            | 2026-11-09 06:07                | DETECTION_REPORT_FAILED         |
| ac39f8d2            | 2026-11-07 08:38                | RATE_LIMITED                    |
| 0183252d            | 2026-11-06 07:08                | RATE_LIMITED                    |
| 2c9871b6            | 2026-11-06 07:06                | RATE_LIMITED                    |
| d9d2dfdd            | 2026-11-05 20:42                | RATE_LIMITED                    |

For asset `78df0238`, the same task was submitted at 20:56:18, observed PENDING at 20:56:23,
then observed ERROR at 20:56:32, :41, :49 and :57. The final observation exhausted recovery.
These are repeated GETs of the same task, not four submissions or four content verdicts.

The adapter maps validated failed tasks other than MEDIA_INVALID/PROVIDER_TIMEOUT to
MODERATION_UNAVAILABLE. That code is retryable. `MEDIA_VERIFICATION_RETRY_POLICY` permits four
transient failures; `recordMediaVerificationWaitOrFailure` then marks the asset failed and the
review BLOCKED. Existing tasks retain their IDs and do not enter the fresh submission branch.
The model-generation stage is never reached for these assets. The upstream errors are technical;
there is no successful classification result or policy rejection. SeeAPI's messages do not establish
the deeper cause of its report-processing failures or which internal rate-limit bucket was hit.

This investigation does not alter retry classification or settle/requeue historical customer records.
