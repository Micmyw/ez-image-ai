# Video beta for all authenticated accounts

The owner authorized opening ordinary Video to all accounts on 2026-10-07. This
follow-up supersedes the internal-only audience decision in
[the original rollout](video-v1-rollout.md) and
[the October 5 activation checkpoint](video-v1-activation-2026-10-05.md).
Those documents retain their historical acceptance and deployment evidence.
The owner's subsequent instruction removes user/model-option test allowlists and
the fixed ordinary-video price-approval cutoff. This document describes that
current policy; earlier local results below are preserved as a separate checkpoint.

## Release policy

- `VIDEO_V1_ACCESS=authenticated` admits signed-in, non-anonymous accounts when
  `VIDEO_V1_ENABLED=true` and service readiness passes. Missing access settings
  retain administrator-only internal rollback access. Invalid settings deny new
  admission. Guests must sign in; there is no guest video trial.
- Generation still requires qualifying paid-credit lots and the existing
  complete-cost quote. The administrator acceptance funding exception applies
  only to the internal ordinary-video audience and must not fund authenticated
  customer requests.
- Ordinary catalog, upload and admission follow the implemented Kie model
  contracts and supported mode/duration/resolution/framing/audio tuples. There is
  no user-ID or model-option test allowlist. Unsupported provider options,
  unpriced tuples and missing required service checks remain unavailable. No
  additional real paid provider acceptance is inferred from catalog availability.
- `VIDEO_PRICE_VALID_UNTIL=none` explicitly removes the ordinary policy's fixed
  approval deadline. Quotes still expire after ten minutes and a price change
  requires a fresh quote and confirmation. Previously accepted finite price
  deadlines remain frozen and are honored before a paid submission; do not
  backfill old jobs to the no-deadline policy.
- Older private policy may carry `VIDEO_V1_ALLOWED_USER_IDS` and
  `VIDEO_MODEL_ALLOWED_OPTIONS` for transport compatibility. Admission ignores
  those fields and standard packing strips them. Preserve supplier price/version
  checks, complete-cost calculations, moderation, concurrency, private storage,
  immutable snapshots and uncertain-submission recovery.
- Hotel Lobby and Raindance keep their own audience, readiness, complete-cost
  budgets, funding and finite price approvals. Opening ordinary Video must not
  widen templates configured as internal or remove their expiry checks.
- Existing status/history and eligible private results remain owner-scoped and
  readable when new generation is closed. The editor's Video control links to
  `/video`; it does not submit a generation or spend credits.

## Receiver-first deployment

1. Verify the implemented model catalog, anonymous-account exclusion, independent
   template access, paid-credit funding, explicit no-deadline pricing and frozen
   accepted-price decisions locally. No schema migration is required for these
   policy changes.
2. Build and deploy the compatible background Worker first, retaining
   `VideoGenerationWorkflowV1`, native bindings and accepted Workflow recovery.
   Keep the website's ordinary-video audience internal until this receiver is
   confirmed deployed.
3. Apply the same audience policy to both website and background runtime
   `VIDEO_RUNTIME_CONFIG` objects. Preserve every unrelated setting, credential,
   payment environment and template policy. For Git builds, set the dedicated
   `VIDEO_V1_BUILD_ACCESS=authenticated` overlay on both build targets so the
   authoritative environment package cannot restore the old internal audience.
   Keep the existing admission build switch enabled only with valid private
   policy whose `VIDEO_MODEL_CONTRACT_VERSION` matches the code's
   `VIDEO_MODEL_CATALOG_VERSION`. No model-option allowlist is required. The
   coordinated Seedance release
   also sets `VIDEO_V1_BUILD_PRICE_VERSION=kie-public-2026-10-07.1` and
   `VIDEO_V1_BUILD_PRICE_BASIS` to the new public supplier evidence appendix on
   both targets. Set `VIDEO_V1_BUILD_PRICE_EXPIRY=none` on both targets to apply
   the explicitly authorized ordinary no-deadline policy. This narrow override
   preserves the inherited complete-cost basis and all template finite approvals;
   missing or invalid price evidence still stops the build. Without the explicit
   expiry override, an inherited finite approval must remain unexpired. Newly
   packed runtime policy omits the two retired allowlist fields.
4. Deploy the website after the compatible receiver. Inspect the generated
   runtime policy and exact deployment version/SHA for both targets. Build or
   binding success alone does not establish live authenticated access.
5. Check that guest `/video` access requires sign-in, an ordinary signed-in
   account can read supported Kie model settings and obtain an eligible quote,
   and missing paid funding is denied. Check multiple supported settings against
   the implemented contract, including ones absent from the retired test list.
   Confirm the editor's Video link and private history. These read/quote checks
   do not start a paid provider request.

## Rollback and drain

Set `VIDEO_V1_ACCESS=internal` in both runtime policies and
`VIDEO_V1_BUILD_ACCESS=internal` on both build targets to restore the internal
administrator audience; this does not restore a user-ID test allowlist. For an
admission shutdown, set the separate `VIDEO_V1_ENABLED=false`
on both Workers and `VIDEO_V1_BUILD_ENABLED=false` on both build targets so later
builds remain closed. Changing audience or admission must not cancel accepted
tasks, release unresolved reservations or resubmit uncertain paid attempts.

Let accepted video work drain through its saved Workflow identity and immutable
policy. Preserve private owner access, settlement, ledger and schema. Restore
compatible code and policy together if code rollback is required; do not send
video work to the legacy executor. Template admission and history keep their
independent settings and owner checks.
To restore a finite deadline for new ordinary requests, apply a newly approved
finite `VIDEO_PRICE_VALID_UNTIL` consistently to both runtime policies and remove
the `VIDEO_V1_BUILD_PRICE_EXPIRY=none` overlays. Do not rewrite saved accepted
price decisions. Code predating explicit `none` support requires a matching
finite policy before rollback.

## Release evidence

The current no-allowlist/no-deadline follow-up has not yet been certified by this
document. The release operator records its focused checks, exact-SHA CI,
deployment versions and live browser evidence separately below. Do not infer
live customer generation from the policy or copy change.

| Current follow-up stage                                                        | Evidence                          |
| ------------------------------------------------------------------------------ | --------------------------------- |
| Kie contract/catalog, funding and independent-template checks                  | PASS: focused integrated checks   |
| Ordinary no-deadline policy and immutable accepted finite deadlines            | PASS: 15 unit / 135 UTC DB checks |
| Build overlays and retired transport-field removal                             | PASS: 266 web-host checks         |
| Git publication and exact-SHA CI                                               | Pending release evidence          |
| Background Worker and website deployment versions                              | Pending release evidence          |
| Guest exclusion and authenticated live catalog/quote across supported settings | Pending release evidence          |
| New real paid provider generation and moderation acceptance                    | NOT_RUN for this policy follow-up |

The follow-up passed 687 distinct focused local checks: 174 config/contract tests,
57 API tests, 96 jobs tests, 15 frozen-approval unit tests, 266 web-host tests,
68 SaaS model/render/composer tests and 11 configuration CLI tests. Root
`pnpm type-check` passed all 22 tasks; changed-file lint, format and diff checks
pass. The 135 UTC PostgreSQL admission/execution regressions are separate and
cover explicit no-deadline admission after October 12, the unchanged ten-minute
quote lifetime, paid reservation, first submission, legacy finite expiry and
accepted/uncertain recovery. Their exclusive local server and seven tracked
processes were stopped and port 55439 was confirmed closed. No migration or
production database write was required.

The Kie Seedance 1.5 Pro documentation was read again at this checkpoint and
confirms whole-second durations 4–12, 480p/720p/1080p and the documented sound
and aspect controls. A 5-second/720p request no longer depends on an operator
test list. Other implemented models retain their versioned supplier contracts;
unsupported mappings and missing pricing are not granted by deleting lists.

### Earlier authenticated-audience checkpoint

These results describe the preceding audience-only implementation and do not
certify the subsequent contract-catalog and price-deadline changes.

| Stage                                                                 | Evidence                          |
| --------------------------------------------------------------------- | --------------------------------- |
| Focused local access, funding, template and build-overlay regressions | PASS: 494 focused tests           |
| Changed-file formatting, lint and affected workspace type checks      | PASS                              |
| Authenticated/guest live browser acceptance                           | Pending production release        |
| Git publication and exact-SHA CI                                      | NOT_RUN at document creation      |
| Background Worker and website deployment versions                     | NOT_RUN at document creation      |
| Guest exclusion and ordinary authenticated live catalog/quote         | NOT_RUN at document creation      |
| New real paid provider generation and moderation acceptance           | NOT_RUN for this audience release |

The integrated focused checks comprise 103 config pricing/access/funding/template
tests, 39 runtime transport tests, 213 web-host deployment/build tests, 25 API
catalog/upload tests, 35 jobs admission/template-access tests, and 68 shared
image-composer/video model/render tests.
The 11 Hotel Lobby configuration CLI tests also pass after the integrated
Node environment dictionary is validated and narrowed to string values.
The composer regression failed before the link change and passed afterward.
Config, jobs, API, SaaS and web-host type checks pass. Local generation repaired a
stale ignored Prisma client; one stale ignored Next route type for the removed
Effects route was removed before rerunning SaaS type validation. No schema change,
production database write, upload or paid provider call was needed. The separate
authorized Seedance implementation was incorporated as `b7739f3d` from
`fb28f4a1`, preserving both release entries and authenticated-access documentation.
Its earlier 46 isolated PostgreSQL tests and 8 Mock browser cases remain separate
evidence; the integrated CI validates the final published source.

The intermediate `2f7729d7` CI reported `TS2345` in the configuration example
test because Node's parsed environment dictionary can contain undefined values.
The same error was reproduced locally, fixed by validating each parsed value,
and the 11 CLI tests plus root `pnpm type-check` pass (22 successful tasks).
No workflow gate or product behavior was weakened.
