# Video beta for all authenticated accounts

The owner authorized opening ordinary Video to all accounts on 2026-10-07. This
follow-up supersedes the internal-only audience decision in
[the original rollout](video-v1-rollout.md) and
[the October 5 activation checkpoint](video-v1-activation-2026-10-05.md).
Those documents retain their historical acceptance and deployment evidence.

## Release policy

- `VIDEO_V1_ACCESS=authenticated` admits signed-in, non-anonymous accounts when
  `VIDEO_V1_ENABLED=true` and service readiness passes. Missing access settings
  retain the internal administrator/user-ID audience. Invalid settings deny new
  admission. Guests must sign in; there is no guest video trial.
- Generation still requires qualifying paid-credit lots and the existing
  complete-cost quote. The administrator acceptance funding exception applies
  only to the internal ordinary-video audience and must not fund authenticated
  customer requests.
- Preserve the current `VIDEO_MODEL_ALLOWED_OPTIONS`, price references and their
  expiries, moderation settings, concurrency limits, private storage, immutable
  snapshots and uncertain-submission recovery. A listed model or priced tuple is
  not evidence that it is enabled or that real paid acceptance has been rerun.
- Hotel Lobby and Raindance keep their own audience, readiness and funding
  policy. Opening ordinary Video must not widen templates configured as internal.
- Existing status/history and eligible private results remain owner-scoped and
  readable when new generation is closed. The editor's Video control links to
  `/video`; it does not submit a generation or spend credits.

## Receiver-first deployment

1. Verify the compatible audience parsing, anonymous-account exclusion,
   independent template access and paid-credit funding regressions locally.
   No schema migration is required for this audience change.
2. Build and deploy the compatible background Worker first, retaining
   `VideoGenerationWorkflowV1`, native bindings and accepted Workflow recovery.
   Keep the website's ordinary-video audience internal until this receiver is
   confirmed deployed.
3. Apply the same audience policy to both website and background runtime
   `VIDEO_RUNTIME_CONFIG` objects. Preserve every unrelated setting, credential,
   payment environment and allowed model tuple. For Git builds, set the dedicated
   `VIDEO_V1_BUILD_ACCESS=authenticated` overlay on both build targets so the
   authoritative environment package cannot restore the old internal audience.
   Keep the existing admission build switch enabled only with the current valid
   private policy and nonempty model allowlist.
4. Deploy the website after the compatible receiver. Inspect the generated
   runtime policy and exact deployment version/SHA for both targets. Build or
   binding success alone does not establish live authenticated access.
5. Check that guest `/video` access requires sign-in, a non-allowlisted signed-in
   account can read the catalog and obtain an eligible quote, and missing paid
   funding is denied. Confirm the editor's Video link and private history. These
   read/quote checks do not start a paid provider request.

## Rollback and drain

Set `VIDEO_V1_ACCESS=internal` in both runtime policies and
`VIDEO_V1_BUILD_ACCESS=internal` on both build targets to restore the internal
audience. For an admission shutdown, set the separate `VIDEO_V1_ENABLED=false`
on both Workers and `VIDEO_V1_BUILD_ENABLED=false` on both build targets so later
builds remain closed. Changing audience or admission must not cancel accepted
tasks, release unresolved reservations or resubmit uncertain paid attempts.

Let accepted video work drain through its saved Workflow identity and immutable
policy. Preserve private owner access, settlement, ledger and schema. Restore
compatible code and policy together if code rollback is required; do not send
video work to the legacy executor. Template admission and history keep their
independent settings and owner checks.

## Release evidence

Local verification is complete. Remote stages are recorded separately in the
release receipt; do not infer live customer generation from the policy or copy change.

| Stage                                                                 | Evidence                          |
| --------------------------------------------------------------------- | --------------------------------- |
| Focused local access, funding, template and build-overlay regressions | PASS: 368 focused tests           |
| Changed-file formatting, lint and affected workspace type checks      | PASS                              |
| Authenticated/guest live browser acceptance                           | Pending production release        |
| Git publication and exact-SHA CI                                      | NOT_RUN at document creation      |
| Background Worker and website deployment versions                     | NOT_RUN at document creation      |
| Guest exclusion and non-allowlisted authenticated live catalog/quote  | NOT_RUN at document creation      |
| New real paid provider generation and moderation acceptance           | NOT_RUN for this audience release |

The focused checks comprise 55 config access/funding/template tests, 37 runtime
transport tests, 191 web-host deployment/build tests, 21 API catalog/upload tests,
35 jobs admission/template-access tests, and 29 shared image-composer render tests.
The composer regression failed before the link change and passed afterward.
Config, jobs, API, SaaS and web-host type checks pass. Local generation repaired a
stale ignored Prisma client; one stale ignored Next route type for the removed
Effects route was removed before rerunning SaaS type validation. No schema change,
production database write, upload or paid provider call was needed.
