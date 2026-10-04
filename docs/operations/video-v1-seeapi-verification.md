# SeeAPI video visual moderation follow-up

Evidence date: 2026-10-04. This implements the user's explicit selection to replace new
video visual moderation with SeeAPI and align its visual settings with SeeAPI image
moderation, use Waffo for prompts and retire Sightengine throughout the runtime.
Native sound remains available; audio moderation is outside the current scope. The prior
[multi-model delivery report](video-v1-followup-verification.md) remains historical evidence;
its builds and performance results predate this change.

Source-workspace branch: `main`. HEAD: `569bf39eea9dcf072d3c5e5f79d58cd38d6bb466`.
Existing dirty work was preserved. The latest handoff is a separate GitHub review branch,
`codex/video-v1-release`, integrated onto remote `main`
`e4f6b81fd8fc8e769b975e6c59177a1afefa06a9`. Its exact checks are recorded in
[the review-branch verification](video-v1-review-branch-verification.md).
This handoff does not merge main, migrate production, deploy or open video. No paid call was made.

## Implementation

- New SeeAPI adapter uses `POST /v1/inferences`, model `video-nsfw-filter`, endpoint
  `video-moderation`. A verified, durably persisted callback starts one confirmation
  flow using authenticated `GET /v1/inferences/{id}` and the server's stored task ID.
  HTTP 202 is acceptance only. Task identity, terminal state, schema, frame counts,
  timestamps and aggregate/frame consistency must all pass.
- Visual settings match the existing image adapter: `threshold_offset=0` and
  `strict_special_care=true`. `return_frames=none`; requested samples are
  `clamp(ceil(requestedSeconds) + 2, 8, 32)`. Evidence explicitly records
  `sampled_frames`; it does not certify every frame. Optional omitted `special`
  categories are not represented as returned empty categories.
- A canonical `inputSnapshot.visualSafetyProfile` freezes provider, contract,
  rule/policy versions, frame count and coverage settings. New quotes bind the
  profile and cost policy to their security fingerprint. Provider or policy drift
  requires a new quote before reservation. Accepted replays reuse the existing job
  and reservation before checking mutable configuration.
- Existing migration `20261004030000_video_input_snapshot_immutable` freezes the entire
  accepted video input snapshot at PostgreSQL level. Historical snapshots are not
  backfilled. Existing engine immutability prevents switching engines to bypass it.
  This callback phase adds no further migration.
- Sightengine is retired across current runtime paths, including old-job draining.
  Historical profiles and evidence remain immutable; unfinished work requiring that
  provider is held without outbound checks or an implicit switch to SeeAPI. Historical
  `READY` results keep only bounded owner/evidence/expiry/settlement-checked access.
  Old callbacks cannot restart retired work or bind SeeAPI jobs.
- New requests freeze Waffo `textSafetyProfile` with rule
  `waffo-prompt-safety-2026-10-04.1`. Complete positive Waffo evidence is required before
  paid generation; technical failures and historical bypass evidence never grant new
  execution permission. Existing SeeAPI input-image and Kie generation behavior is retained.
- Server-only callback configuration validates the URL HMAC secret and provider
  signing-key map. The receiver verifies the asset/generation/attempt-bound URL and
  raw-body HMAC, stores the original payload/hash, deduplicates the bound attempt and
  wakes only its video Workflow. A durable budget permits at most three GET requests
  total, including the first, and caches the completed result. Only network failures,
  timeouts, 429 and 5xx retry, with 1-second then 3-second backoff. Duplicate callbacks
  and recovery cannot reset that budget; notification body fields never control task
  lookup, approval or settlement.
- Missing callback at the deadline, exhausted transient GET retries, a nonretryable
  confirmation failure, or a nonterminal GET result enters
  `NEEDS_REVIEW` with playback unavailable and credits reserved for manual handling.
  There is no recurring SeeAPI output polling, repeat moderation POST or replacement
  generation. Timeout, uncertain confirmation, provider task failure and a confirmed
  content rejection remain distinct outcomes.
- Actual stored output must fit SeeAPI's conservative 100,000,000-byte and
  30,000-ms limits before the may-have-sent fence. Local preflight failure does not
  submit a paid request. Unknown submission acceptance is held and never blindly
  resubmitted. Storage recovery still has no generation-submit dependency.
- A genuine visual `REVIEW` parks the job as `NEEDS_REVIEW` with reserved credits;
  it is not treated as a confirmed content rejection. Native model sound remains
  supported. New snapshots and pricing bind
  `audioSafetyPolicy={schemaVersion:1,mode:'not_requested'}`; there is no transcription,
  audio-review call, key, charge or fabricated audio approval. Historical audio-bearing
  work that still requires audio review is held without rewriting its accepted policy.
- `VIDEO_COST_VISUAL_POLICY_VERSION` must match the selected frozen policy before
  quoting; `VIDEO_COST_TEXT_RULE_VERSION` must match the frozen Waffo rule. Real account
  cost settings remain required; the provider change does not
  silently approve an older moderation budget.

Changed files and responsibilities are in the
[actual file map](../implementation/video-v1-file-map.md). Configuration and rollout
instructions are in [the example](video-v1-configuration.example.env) and
[the operations guide](video-v1-rollout.md). Public SeeAPI credit units and the
account-specific USD conversion gap are documented in
[video pricing](../product/video-model-pricing.md).

## Callback decision

The [video inference documentation](https://www.seeapi.com/docs/video-nsfw-filter/video-moderation/)
allows `callback_url`. The
[authentication documentation](https://www.seeapi.com/docs/authentication/) confirms
SeeAPI offers a separate Webhook Signing Secret; the
[general guide](https://www.seeapi.com/docs/getting-started/) recommends signed
notifications plus polling recovery. The user's explicit decision for SeeAPI video
output review is **callback-only**, accepting manual recovery when notification or
confirmation fails. The implementation intentionally omits the guide's polling fallback.

The raw-body HMAC verifier follows the official authentication guidance and its
[public signing example](https://www.seeapi.com/_next/static/immutable/chunks/40t71rwpea69l.js)
(the captured source hash is recorded in `seeapi-video-webhook.ts`). A separate
server-generated URL proof binds the immutable asset, verification generation and
attempt. The receiver verifies both proofs, persists the original payload and hash,
deduplicates the attempt, then wakes the browser-independent Workflow. No inference
event-body schema is guessed; notifications are evidence to wake work, never verdicts.

After a verified notification is durable, one confirmation flow queries the server's
already stored moderation task ID. It permits at most three authenticated inference
GET requests total, including the first. Only network failures, timeouts, HTTP 429 and
HTTP 5xx retry, with 1-second then 3-second backoff. The budget and completed result are
persisted; duplicate callbacks and Workflow recovery cannot reset the request count or
query again after a completed result. A processing/nonterminal result, invalid response
or rejection does not retry. No callback means zero confirmation GET requests. The
result must still satisfy the frozen profile, content identity and report validation
before existing review and settlement rules apply.

No callback by the deadline, exhausted transient retries, a nonretryable confirmation
failure, or a nonterminal GET result parks the job
as `NEEDS_REVIEW`: output remains unavailable and credits remain reserved for authorized
manual handling. The system performs no later automatic poll, additional moderation
POST or replacement generation. Missing notification is not a content rejection or an
automatic credit release. Existing Kie and SeeAPI input-image mechanisms are unchanged;
Sightengine remains retired and cannot resume work through old callbacks.

Real signed delivery and the event envelope's compatibility with moderation
**inferences** remain **NOT_RUN** and require authorized external acceptance. The
generic signing code is implemented; that does not establish real inference delivery,
live callback registration, production activation or a measured latency improvement.
Real performance remains **NOT_RUN**.

## Verification

All external generation/moderation HTTP in automated tests is mocked or served by
local workerd fixtures. Real isolated PostgreSQL uses the task-owned loopback port 55439. These source-checkout results do not prove live SeeAPI, Waffo, Kie, R2 or Hyperdrive behavior,
or certify the newer release checkout before its integration checks.

| Check                                            | Result                                                                                   |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Fresh isolated PostgreSQL migration deployment   | PASS: 59 migrations, including all four video migrations                                 |
| Video input snapshot SQL immutability regression | PASS: 15 tests                                                                           |
| Current video unit/Mock/runtime suite            | PASS: 567 tests in 38 files; includes 15 native workerd tests                            |
| Current video database regression                | PASS: 81 tests in 7 files                                                                |
| Workspace type checks                            | PASS: 22/22 tasks                                                                        |
| Waffo / SeeAPI complete domain flow              | PASS: 15 tests; 3 optional performance cases NOT_RUN                                     |
| Legacy moderation outage quote regressions       | PASS: 8 isolated PostgreSQL tests; historical BYPASS cannot authorize new work           |
| Legacy Sightengine compatibility and settlement  | PASS: 5 isolated PostgreSQL tests, including 2 regression cases reproduced before repair |
| New release checkout integration                 | See the separate review-branch verification record                                       |
| Final website/Jobs build                         | See the separate review-branch verification record                                       |
| Hosted CI                                        | NOT_RUN                                                                                  |
| Real external acceptance                         | BLOCKED / NOT_RUN                                                                        |
| Production migration, deployment and opening     | NOT_RUN; no production change performed                                                  |

Root logs: `.cache/video-v1/seeapi-final-scope-unit.log`,
`seeapi-final-scope-database.log`, `seeapi-final-scope-typecheck.log`,
`waffo-seeapi-final-flow.log`. Earlier `seeapi-video-*` logs are intermediate results.
Individual focused counts in
sub-agent reports overlap these suite counts and must not be added as unique tests.
The workerd test logs include the existing deliberately forced Workflow event-timeout
diagnostic; the recovery assertion then completes the workflow to READY. It is not
suppressed or used as evidence of a live Cloudflare execution.

Independent code reviews checked provider/report compatibility, frozen quote/cost
contracts, historical replay, SQL immutability, callback isolation, uncertainty fences
and historical audio holds. An independent reviewer found a historical Sightengine rejection
being misclassified as an ordinary generation failure during settlement. The owner reproduced
both affected provider identities, repaired the evidence match and verified the original
first-block-free billing policy. The remaining reviewed scopes had no confirmed unresolved defect.

## External acceptance and performance limits

- Credential presence was checked without printing values: Kie, SeeAPI and Waffo credentials
  exist locally and on both current production Workers. This is not model-access acceptance.
- BLOCKED: Kie webhook secret, SeeAPI signing-key map, callback URL secret, approved current
  moderation cost basis and SeeAPI account credit-to-USD conversion, model permissions and
  an authorized paid acceptance budget. Current production has no video Workflow binding yet.
- NOT_RUN: real sampled-frame coverage, accurate duration/codec/output acceptance,
  flagged/review outcomes and real provider billing. Audio moderation is not in scope.
- The application's coverage requirements (first sample <=250 ms, last within
  duration-1 s to duration+0.5 s, maximum adjacent gap 1 s) are acceptance rules,
  not a distribution promised by the SeeAPI documentation. Real samples must prove
  compatibility; incomplete coverage remains held.
- SeeAPI-specific real stage latency is NOT_RUN. The prior local multi-model
  performance record remains unchanged and must not be relabelled as a SeeAPI
  benchmark. Its 20-concurrent admission target remains NOT_MET; beta concurrency
  remains capped at 5.

## Deployment and rollback

Apply the four additive video migrations before authorized activation. Supply server-only
credentials and approved cost settings consistently to website and background Workers.
Sightengine credentials and executable adapters are retired; unfinished old tasks remain held.
Close new admission for rollback, keep the independent Workflow and the fixed accepted
policy evidence available for supported accepted jobs, and preserve the new immutable
snapshot trigger. Do not rewrite accepted profiles, reset uncertain attempts or send
video jobs through the legacy Outbox engine. Production rollout/rollback drills are
NOT_RUN.

Resource cleanup and final artifacts will be recorded after the final local checks.
