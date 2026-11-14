# Image prompt moderation, repeat reminder and output-rejection billing

Owner request: warn before repeating an image prompt and retire the first output-block waiver.

## Behavior

The registered image composer checks the account's latest 20 legacy image tasks before submission.
The authenticated POST `/media/prompt-match` derives the owner from the session and returns only
one matching job ID. It compares NFC text after trimming and collapsing whitespace; changed words
are not treated as identical. It neither exposes another owner's history nor writes a job or quote.
Prompt matching is advisory, across image models and reference images, not semantic matching or
a guarantee against concurrent submissions from separate clients. Older-than-20 matches are not checked.

A match offers the existing task, prompt revision, and explicit generation confirmation under
the displayed funding policy. A failed check also requires confirmation instead of silently sending.
Changing the input/account invalidates the confirmation; repeated clicks share the submission gate.
Existing idempotency and uncertainty handling remain responsible for accepted or unknown requests.

New ordinary CREDITS quotes freeze `outputModerationBillingPolicy=charge-quoted-credits-v1`.
Confirmed output-content rejection charges the quoted maximum even if the account has never used
the old waiver. Existing `first-block-free-v1` and unmarked historical snapshots remain immutable.
Input blocks, unresolved review, technical failures, guest sponsorship and Image Pass contracts
retain their existing settlement rules. No customer ledger or production job is rewritten.

Deploy compatible settlement readers on all active jobs runtimes before the website's new quote
producer. Retain these readers until new-policy tasks drain on rollback. No migration is required.
Local changes do not establish deployment or live behavior.

## Image prompt provider change

At the owner's clarified scope, only image generation switches to SeeAPI primary with Waffo
technical-failure fallback. Video and video templates retain Waffo and their frozen policies.
The shared API adapter covers registered quotes, guest admission, retry and administrator rechecks.
The new rule version invalidates unaccepted old prompt quotes through the existing admission fence;
accepted jobs and historical evidence remain frozen. Use the existing SeeAPI and Waffo credentials,
keeping `MODERATION_TEXT_WAFFO_ENABLED=true` to require the fallback configuration.

SeeAPI checks all seven categories at threshold 0.3. Only complete consistent results can allow;
rejections and review signals never invoke Waffo. Explicit technical errors or transport/service
failures may use a complete Waffo verdict. Pending responses retain their task for query-only retry;
unknown terminal codes and credential/input errors stay closed. Both providers failing denies
admission. No image delegation scope or production state was changed.

## Guest investigation

The 2026-11-14 22:16 Asia/Shanghai asset `asset_0b603a3bf74f43608ba76999e9fcf49d`
belongs to `GUEST_TRIAL` and ended `MODERATION_RATE_LIMITED`. Authenticated SeeAPI retrieval confirmed
task `task_943b2717bae34440bdd4c34cdd4d09b3` failed with `RATE_LIMITED`, null result and zero consumption.
Existing technical input delegation requires `USER/ACCOUNT`; it explicitly excludes guest inputs.
This scope mismatch explains the failure to continue without relying on the current deployed flag state.

The 22:37 guest asset `asset_6badec216bdb47b697c8e14e86a8ed64` had an aborted upload with
`UPLOAD_FINALIZATION_VALIDATION_FAILED`, no moderation task and no committed checksum. Both guest
owners had zero generation jobs, guest trials or link intents at inspection. This proves no admitted
generation under those identities, not whether the UI button was clicked. Visually identical photos
can have different bytes after resizing/re-encoding; no cross-owner review reuse is inferred.

## Registered customer investigation

Read-only production evidence for owner `cmvu0d2t20001psp7ojx7cfih` showed one historical
10-credit login grant. Three distinct MiniMax H3 1K jobs each reserved five credits:

| Job                         | Outcome                                                              | Charged credits |
| --------------------------- | -------------------------------------------------------------------- | --------------- |
| `cmwgiipgj0004psp7tp2l42rf` | Output blocked; `OUTPUT_CONTENT_BLOCKED_WAIVED` under the old policy | 0               |
| `cmwgikvrd000epsp7sod10ev2` | Succeeded; output approved                                           | 5               |
| `cmwgilgyc000mpsp75erz826r` | Succeeded; output approved                                           | 5               |

The first reservation released five credits, enabling the third attempt. Each job had one first
generation-provider attempt; these were not three retries of one job. Jobs 1 and 2 used the same
prompt; job 3 removed a phrase. All three original quote text reviews were Waffo `ALLOW`.
This ledger explanation does not link the separate guest identities to this customer.

## Live text-moderation comparison

At 2026-11-15 00:04:02–00:04:10 Asia/Shanghai, the two distinct Turkish prompts from the investigated
customer jobs were each sent once to each provider. No translation, image, generation callback,
customer identifier, generation request or production business-state mutation was involved.
Waffo used the existing production adapter (`locale=en`, `semantic=enforce`, fresh scan without
prompt-derived idempotency). SeeAPI used `text-nsfw-filter` / `text-moderation`, threshold 0.3,
all seven default categories and a unique idempotency key per prompt. This comparison did not switch
the deployed moderation provider; the subsequent implementation above is local pending release.

| Sample                 | SHA-256                                                          | Waffo                        | SeeAPI       | Sexual explicit / suggestive scores |
| ---------------------- | ---------------------------------------------------------------- | ---------------------------- | ------------ | ----------------------------------- |
| Original, jobs 1 and 2 | e4da24f9bd61c31ca73157bb506178708544f3d972ad8e65494aabc99a3a4b36 | ALLOW, scored, no categories | flagged=true | 0.89 / 0.94                         |
| Shortened, job 3       | 9524ad83cf14fb96e47898aea2022214be14326fcb24a1f6e2bbc51ae2b7234e | ALLOW, scored, no categories | flagged=true | 0.82 / 0.91                         |

SeeAPI tasks: `task_5944eaadea914f0abd5784a08960a03f`, `task_865336f6e3bc4557b204a678131b348d`.
Both returned HTTP 200 / succeeded, 0.022 provider credits each (0.044 total).
Waffo request references: `c809e4656eb849f0ab90fa6c3dc8b514`, `fea5e1992ac244bdab126a4b010de37f`.
Full sanitized scores and token counts are retained locally in the ignored
`.cache/text-moderation-2026-11-15/results.json`; no credentials or signed media URLs are included.

These two cases reproduce Waffo's false negatives and show SeeAPI detection for these samples only.
SeeAPI also flagged other categories, including sexual_minors; that classifier label is not evidence
that the prompt or image involved a minor. No images were inspected in this comparison, and no general
accuracy or false-positive rate can be inferred. The fixed English Waffo locale is an observed
configuration, not a proven explanation of the miss.

Contract: https://www.seeapi.com/docs/text-nsfw-filter/text-moderation/

## Local verification

- 38 shared SeeAPI text adapter cases: complete allow/reject, HTTP and terminal technical errors,
  malformed restrictive responses, pending task reuse, stable retry keys, bounded response size,
  timeout cancellation, and incomplete/denied Waffo fallback decisions.
- 132 focused API tests: prompt moderation/denials, quote policy, bounded retries, registered retry,
  guest admission, duplicate history ownership, and administrator rechecks/diagnostics.
- 152 image composer/hook/notice tests, including stale warning confirmation, duplicate clicks,
  switching to video and revising a prompt without resetting submission identity.
- 12 administrator diagnostic projection tests and 10 real PostgreSQL settlement cases on the
  disposable loopback-only database: current first rejection charged, frozen legacy waiver,
  idempotent settlement, fresh-read on/off, and non-chargeable outcomes.
- Affected API, jobs, AI and SaaS type checks; affected-file formatting/lint; four-locale key and
  interpolation parity, with 42 changed English/German message renders. Client message projections
  remained current. No full CI, cloud deployment or production generation is asserted.
