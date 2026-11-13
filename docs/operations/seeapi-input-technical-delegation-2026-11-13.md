# SeeAPI terminal errors and input delegation

## Findings

The nine screenshot assets stopped during INPUT verification, before a generation-model
attempt existed. Authenticated SeeAPI retrieval returned HTTP 200, `status=failed`,
`result=null`: five `DETECTION_REPORT_FAILED` and four `RATE_LIMITED` tasks.
Each asset had one pending observation and four errors against the same task ID. They
were repeated status queries, not four inference submissions or four content rejections.

`RATE_LIMITED` means the detection request was rate limited. `DETECTION_REPORT_FAILED`
means the detection result could not be processed. These messages establish technical
failure; they do not identify which internal SeeAPI component failed or prove an account
quota problem. No generation-model rejection was involved in these nine cases.

Official references checked on 2026-11-13:

- [Image moderation 2.0](https://www.seeapi.com/docs/nsfw-filter-2/image-moderation/):
  accepted 202 responses are pending; GET 200 is a successful lookup, not a moderation
  verdict. A completed flagged result is a content match, not task failure. Downloads
  and preprocessing can fail after acceptance. Input dimensions/format/size limits apply.
- [Task details](https://www.seeapi.com/docs/get-task-detail/): general task lifecycle
  guidance distinguishes lookup failures from terminal task failures and says to stop
  polling terminal states. This general page describes `/generations`; the image
  integration continues to use the image-specific `/inferences` endpoint.

The image page lists HTTP 400/401/402/403/404/409/422/429/503 with generic descriptions;
it does not publish an exhaustive machine-error-code catalog. HTTP request/lookup errors,
network timeouts and a successful GET reporting `failed` are separate observations.

## Implemented contract

- The adapter retains a bounded terminal task identity, status, model and allowlisted
  code, without provider messages, URLs or credentials. Unknown codes become `UNKNOWN`.
- All validated terminal task failures stop automatic queries on the first observation.
  A failed POST still binds the task before authenticated GET; no extra POST is issued.
- When `MEDIA_SEEAPI_INPUT_FAILURE_DELEGATION_ENABLED` is exactly `true`, a known failed
  `nsfw-filter-2` task with `RATE_LIMITED`, `DETECTION_REPORT_FAILED` or `PROVIDER_TIMEOUT`
  may permit an ordinary USER/ACCOUNT INPUT image to continue. The last code is an
  existing supported technical classification, not an observed cause in the nine cases.
- Eligibility requires the same current task, generation 1, valid inspection/checksum,
  unexpired immutable object, live verification lease/phase ownership, no uncertain
  submission, no content-rejection/review history and no administrator resolution.
- Persist `BYPASSED` plus `SEEAPI_INPUT_TECHNICAL_FAILURE_DELEGATED_V1`, with the actual
  `ERROR` evidence. Keep an open incident and pending administrator review, count the
  failure once, and retain the original task ID. This is never stored as `APPROVED`.
- Permission expires within 24 hours and no later than the input's own expiry. Matching
  input reads, admission and image dispatch accept it; temporary status returns `AVAILABLE`.
  An already waiting image job receives its ordinary durable dispatch continuation in
  the same transaction. Existing reservation, idempotency and provider fences still apply.
- Content rejection, review-required results, invalid media, unknown codes, incomplete
  results, submission uncertainty, configuration/HTTP/network errors, guest inputs,
  video and output delivery do not acquire this permission. Their existing handling stays.
  Terminal output errors stop polling but never release unreviewed output as approved.
- Historical failed jobs and expired references are not automatically reopened. No
  historical prompt, evidence, ledger entry or accepted quote is rewritten.

## Rollout and rollback

1. Apply `20261113092315_seeapi_input_technical_delegation` before enabling new writes.
   It changes PostgreSQL constraints/functions only; Prisma/Drizzle model shapes stay the same.
2. Deploy compatible website/API and every jobs receiver with the switch absent/false.
   Drain incompatible receivers, including hybrid receivers, before the next step.
3. Enable `MEDIA_SEEAPI_INPUT_FAILURE_DELEGATION_ENABLED=true` in the server runtime
   environment and deploy the configured jobs producers. The example defaults off for
   this deployment ordering. This is not a customer control.
4. Observe original SeeAPI IDs, incident counts, model attempt counts and reservations.
   Disabling the switch stops new delegation. Retain readers and the migration while
   already delegated inputs/jobs drain; rolling readers back earlier can block them.

## Verification boundaries

Adapter and policy tests cover terminal-vs-lookup failures and input-only permission.
PostgreSQL regressions exercise real evidence/READY constraints, input admission,
reservation replay, one mocked model submission, waiting-job continuation and excluded
scenarios. Mocked provider calls do not certify a real model's acceptance or content policy.
Local migration/testing does not apply a production migration or enable the live switch.
