# Hotel Lobby duo verification and rollout

This receipt separates local implementation from real provider acceptance and public availability.
Baseline: `96f47c92d5d32bd20640e7029ab08f88a916c4f1`.
Worktree/ownership: [implementation map](../implementation/hotel-lobby-file-map.md).
The user's later instruction authorizes pushing the completed feature branch
`codex/hotel-lobby-duo`. Merge, deployment, production migration, paid calls and
public activation are not authorized. Git and CI evidence are reported separately
from the local checks below.

## External gates

| Item | Status | Required evidence |
| --- | --- | --- |
| Template-specific paid test authorization | BLOCKED | Explicit budget, owner and candidate tuples; old administrator funding is not reused |
| Approved composite cost policy | BLOCKED | Current scene/video costs, both prompt checks, three image checks, final video review, runtime/storage/payment/loss assumptions and expiry |
| Provider account permissions | NOT_RUN | Read-only account/contract verification for the selected image and video combination |
| Two-person quality comparison | NOT_RUN | Same authorized input groups for candidate A/B, all results and receipts retained |
| Real private R2/video/SeeAPI delivery | NOT_RUN | Same immutable stored MP4, authentic callbacks and one actual wallet settlement |
| Twelve-group release quality check | NOT_RUN | At least ten acceptable groups and no severe identity/audio failures; do not market this as a statistical success rate |
| Three public product examples | BLOCKED | Rights-cleared independent public copies, real job evidence and exact matching template version |
| Production migration/deployment/opening | NOT_RUN | Separate authorization plus the above gates |
| GSC/ChatGPT search appearance | NOT_RUN | Actual search/provider observations; no discovery guarantee |

The official candidate references are
[Nano Banana 2 Lite](https://docs.kie.ai/market/google/nano-banana-2-lite),
[Seedance 1.5 Pro](https://docs.kie.ai/market/bytedance/seedance-1-5-pro),
and the existing repository model/pricing contracts. The PRD's scene USD0.02 and video
USD0.0875/USD0.08 numbers are research references, not this task's merchant receipts,
complete cost, or approved retail price. No real sample was manufactured or copied from Migos.

## Private configuration

New admission requires `HOTEL_LOBBY_DUO_ENABLED=true` independently of the existing
video admission switch. Both Workers must receive the same private policy. The strict
video option allowlist must also explicitly permit the selected image-to-video,
5-second, 720p, silent combination.

The frozen template version, separate approved price version/basis/expiry and safety
cost version are required. Scene supplier cost, each input image check, scene image
check, both text checks, additional runtime/storage budgets are explicit. Zero text
cost requires a separately stated basis and matching text policy; omitted cost never
means zero. Existing payment allocation and nonbillable-failure factors are applied
once to the complete combined budget. An expiring template-specific internal funding
authorization is separate from ordinary video administrator acceptance.

The immutable snapshot freezes ordered role identities, prompts/versions, preprocessing,
safety policy, fixed output, scene capacity and retention. Two references may use the
same asset; their role mapping remains explicit. Scene canonical bytes are limited to
10,000,000, with a conservative separate 20,000,000-byte scene capacity reservation.
Final video capacity remains 100 MiB; this does not override SeeAPI's separate
100,000,000-byte review ceiling.

## Local environment and commands

Task-owned PostgreSQL 16 container: `ezpic-hotel-lobby-test-20261005`,
bound only to `127.0.0.1:55439`, database `ezpic_video_v1_final_test`.
It contains disposable fixtures, not production data. Real provider traffic is blocked
by `tests/video-v1/no-paid-network.mjs` for the concentrated runner.

Initial local setup:

- `pnpm install --frozen-lockfile`
- `pnpm --filter @repo/database generate`
- `pnpm --filter @repo/database exec prisma migrate deploy` against the isolated URL
- `pnpm --filter @repo/database exec prisma migrate status`

Migration `20261005100000_video_template_scene` was generated from the actual baseline
database using Prisma migrate diff, then extended with PostgreSQL content-identity,
paid-attempt and output-binding guards. Historical migrations are unchanged.
Prisma generates both Node and workerd clients and tracked Zod types.

Concentrated unit/Mock command:
`pnpm exec tsx tests/video-v1/run.ts --hotel-lobby`.
Concentrated database command:
`pnpm exec tsx tests/video-v1/run.ts --integration --hotel-lobby`,
with the explicit safe loopback `TEST_DATABASE_URL`.
SaaS Vitest, Next/Fumadocs and browser runs must execute sequentially.

Final commands, outcomes and recovery matrix are appended after integrated verification.

## Timing evidence

Admin diagnostics expose actual persisted stage timestamps and nonnegative durations:
request/reservation, input review, scene POST/acceptance/provider completion/storage/review,
derived-input seal, video POST/acceptance/completion/storage/review, final READY.
Missing or inverted observations return null, not zero. Provider wait, transfer, review
and scene-to-video scheduling are separate. Logs contain identifiers and controlled
codes, never prompts, photos or signed URLs.

Real segment times and admission P95: **NOT_RUN**. Unit fixture clock differences are
not cloud performance measurements. Local command duration belongs only to local
verification and must not be represented as generation latency.

## Deployment order and rollback

These are instructions for a separately authorized release; they were not executed.

1. Verify intended repository SHA, target database migration history and private worker
   policy without exposing credentials. Keep template admission false and content draft.
2. Apply the additive migration using the existing controlled Prisma migration procedure.
   Retain the latest multi-model pending-quote fix and original inputSnapshot trigger.
3. Deploy the compatible background receiver/native Workflow, scene callback handler,
   private storage and cleanup support, then the website/API. Verify the actual
   deployed artifacts; local builds are not deployments.
4. Verify packed/flat policy agreement on both Workers, approved prices/expiry, model
   allowlist and private media CORS. Grant only the separately authorized internal
   acceptance cohort and paid budget.
5. Run the bounded real quality/recovery/ledger acceptance. Preserve any uncertain paid
   attempt and stop new paid tests until it is reconciled. Publish only rights-cleared
   product examples from the accepted template version.
6. Open public generation/indexing only after its independent product, pricing and
   content gates pass. A later short provider outage disables generation without
   removing an already-published canonical page from search.

Rollback closes new template admission on both Workers first. Preserve already
accepted frozen versions, sidecars, callback routes, reservations, cleanup and recovery
until they are settled or manually reconciled. Keep the additive schema. Never reset
a scene paid fence, overwrite a derived input, delete unsettled sidecars, move template
jobs to the legacy engine, or release uncertain credits/physical storage in bulk.
Ordinary image and video work continue on their original contracts.
