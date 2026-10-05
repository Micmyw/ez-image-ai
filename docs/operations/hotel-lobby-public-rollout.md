# Hotel Lobby authenticated public beta

This follow-up supersedes the internal-only release scope in the earlier
[implementation receipt](hotel-lobby-verification.md). The owner explicitly asked
to allow everyone to use the template, with a fixed economical Kie model and
revenue at least three times complete cost. Login, qualifying paid credits,
moderation, immutable identities and private delivery remain required.

## Release scope

- `HOTEL_LOBBY_DUO_ACCESS=authenticated` opens this template to every signed-in,
  non-anonymous account. Missing access setting retains internal access; invalid
  settings deny new requests. Ordinary `/video` remains internal.
- Nano Banana 2 Lite 1K prepares the two-person scene; Seedance 1.5 Pro produces
  a 5-second, 720p, 9:16 silent video with a fixed camera. Users upload left/right
  photos and confirm one total quote, without selecting models or writing prompts.
- The reference price is 69 credits under the documented complete budget. The
  server computes and validates each quote from the current private policy; higher
  costs can increase the quote. Never present the reference as a hardcoded bill.
- History stays on the template page and uses the existing owner-scoped APIs,
  including after new generation is disabled. No new payment system is introduced.
- Content is beta and noindex. The sample list and quality acceptance records stay
  empty until real evidence exists. Public beta access does not certify the PRD's
  twelve-group quality comparison or three rights-cleared public examples.

## Model and cost evidence

Official Kie documents checked on 2026-10-05 05:23–05:26 UTC:

- [Market authentication](https://docs.kie.ai/market/quickstart.md) uses a common
  Bearer API key. No separate per-model entitlement endpoint or activation step was
  found. Account balance authentication alone does not prove a generation succeeds.
- [Nano Banana 2 Lite](https://docs.kie.ai/market/google/nano-banana-2-lite.md)
  accepts up to ten references and explicit 9:16 framing. Its English
  [price](https://kie.ai/nano-banana-2-lite) is $0.02 at 1K; the lower Chinese copy
  was not used for budgeting.
- [Seedance 1.5 Pro](https://docs.kie.ai/market/bytedance/seedance-1-5-pro.md)
  explicitly supports 5 seconds, 720p, 9:16, silent output and fixed camera.
  The [public price](https://kie.ai/seedance-1-5-pro) is $0.0875 for this output.
- Seedance 1 Pro Fast saves only $0.0075 and lacks an explicit aspect-ratio field
  in its current contract; it is not selected for the strict portrait preset.

The combined $0.1075 supplier estimate is not full cost or an invoice. The
[complete budget](hotel-lobby-pricing-2026-10-05.md) includes reviews, fees, runtime,
storage and failed outcomes: $0.501228 against minimum qualifying revenue
$1.514136 at 69 credits, ratio 3.02085. Approval expires no later than
2026-10-12T00:00:00Z and earlier if the existing video policy expires. Actual
merchant costs and nonbillable failures must be reconciled before claiming
realized profitability.

## Configuration and deployment

Both the site and Workflow build targets already contain an opaque private
`VIDEO_RUNTIME_CONFIG`. Preserve that current policy. The build-only
`HOTEL_LOBBY_DUO_RUNTIME_CONFIG` overlay is merged inside each build runner, not
reconstructed from a stale local policy. Its allowlist permits only template
access, versions and costs; it cannot change credentials, ordinary video prices,
ordinary audience, administrator funding or enablement. It may append exactly the
fixed image-to-video/5s/720p/silent option tuple without expanding existing groups.
The merged policy remains the single runtime `VIDEO_RUNTIME_CONFIG`; the overlay
is stripped from runtime and public build environments.

1. Start from `b6ac56067df04bd69dd4ef27967d93bcb63baff8`; preserve all unrelated
   shared-checkout work. Validate scoped tests, fresh/restored PostgreSQL, types,
   browser behavior and remote CI.
2. Back up production with verified TLS and restore the backup locally. Apply
   `20261005100000_video_template_scene`, followed by
   `20261005110000_video_template_private_boundary`. The latter enables RLS and
   denies browser/PUBLIC access only on the new table/functions, with fixed function
   search paths. Keep existing migration files and business data unchanged.
3. Prepare the private overlay using `hotel-lobby:prepare-config --build-overlay
--access authenticated`. Review its version, expiry, costs and accepted template
   version. Set the same overlay on both build targets. Explicit runtime acceptance
   records the owner's beta configuration decision; it is not marketing quality
   evidence.
4. Enable the existing `HOTEL_LOBBY_DUO_BUILD_ENABLED` on both compatible targets.
   Deploy jobs before admitting website requests. Verify the native Workflow binding
   and each deployed SHA/traffic allocation, not only Git or build completion.
5. Confirm anonymous login requirement, ordinary-user eligibility, quote, private
   history and unchanged ordinary-video internal access. Record a paid test only
   when separately authorized; preserve the same job and idempotency key on an
   ambiguous response. Never repeat a provider submission just to get green results.

## Disable, drain and rollback

Set `HOTEL_LOBBY_DUO_BUILD_ENABLED=false` in both build targets and deploy compatible
code, closing new template admission. Keep template history and accepted Workflow
executions operational. Do not cancel, refund, resubmit or fail over an uncertain
attempt. Drain or audit the exact existing attempts before rolling back runtime code
that cannot execute their frozen template version.

Keep the additive tables, functions and migration receipts in place during code
rollback. Dropping the sidecar would destroy immutable order identity and recovery
evidence. Full backup restoration is disaster recovery, not a routine release undo;
it would also overwrite unrelated later business activity. The verified local
restore rehearsal is evidence of backup readability, not permission to overwrite
production.

The final delivery receipt records exact Git/CI, migration, deployment, local and
real-service outcomes separately, including NOT_RUN or BLOCKED items and timings.
