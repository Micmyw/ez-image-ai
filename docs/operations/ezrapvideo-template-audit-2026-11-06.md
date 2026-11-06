# Source video template audit — 2026-11-06

This is the initial audit record. Its remaining migration blockers were subsequently investigated
and addressed in the [completion follow-up](ezrapvideo-template-completion-2026-11-06.md): Hotel
has a legal provider-owned contract, Flying Car has four complete original contracts, and material
import/pricing/provision tools now complete the configuration path. Bulin follows the original
reference-audio flow; a new mixing stage is not required for source fidelity.

## Result and scope

The checked source prompts, built-in references and request builders agree with the
archived source contracts. Local tests exercise admission, role review, provider
claim, failure recovery and credit settlement. This is not a live generation or
release acceptance result: the prepared target provisions remain disabled/internal
and lack target prices and private reference approvals.

The user explicitly prohibited real generation. No generation or moderation provider
was called, no production configuration was written, and no real account credits were
reserved or spent during this audit. Network-dependent tests used
`tests/video-v1/no-paid-network.mjs`, scrubbed environment variables and an explicitly
isolated loopback PostgreSQL database. Provider results and review approvals in the
tests are labelled fixtures, not evidence of real moderation or material rights.

## Source fidelity

The comparison baseline is `ez-airapvideo` commit
`75c06e3b5f8141ac45a3bd37fe494b44cc8f7769` plus the previously archived effective source
configuration. Unrelated current edits in the source checkout were not incorporated.

- All 38 archived material files matched their recorded byte lengths and SHA256 hashes.
  This inventory includes legacy material; the current reference set contains 19 files.
- The six effective configured prompts matched the archived source configuration.
- Visual inspection of the 14 current built-in images found the expected scenes,
  poses and role associations. The five WAV durations were 15, 10, 9, 6 and 15 seconds,
  matching their respective contracts. Audio was not certified by listening or by
  rendering a new video.
- Twenty-one copied TypeScript modules matched the fixed source AST. The remaining
  three differences were compatibility changes for own-property checks and abort
  signals, rather than new prompt or generation logic.
- An offline matrix of 6,984 option combinations checked supported mappings, role and
  reference order, prompt image references, duration, aspect ratio, resolution and H3
  request shape. This is deterministic contract evidence, not provider acceptance.

The original builders continue to construct SeeAPI requests for Original Rap/style
routes, Bulin and Spin, and Kie H3 reference requests for 58th Floor, Green Booth and
the pet effects. The adapter introduces no replacement scene-generation stage.
Private references replace archive identities with signed private URLs only after
the stored asset identity and required evidence have been checked.

Provenance is recorded in `packages/ai/media/rap-templates/source-manifest.json`;
effective prompts and archived material identities live beside it. Private source
configuration and access-bearing URLs remain in ignored local storage.

## Generation and credits

Code inspection and the exercised tests confirm these boundaries:

- Protected procedures reject anonymous sessions. The public client submits stable
  template keys, supported options and owned asset IDs, not provider credentials or
  arbitrary provider requests.
- Quotes freeze the owner, ordered input roles, source request, provision version,
  reference identity and configured target price. Admission rechecks the ten-minute
  quote deadline, current eligibility, review policy and immutable input identity.
- Job creation, the shared-credit reservation and native `VideoExecution` start intent
  commit together. Accepted idempotent replays retain the same job and reservation,
  including after configuration closes.
- Every required portrait must have durable successful review. The real database
  claim path rejects a replaced or expired built-in reference before creating an
  initial provider attempt. Repeated claims retain the same attempt.
- Confirmed provider rejection releases a reservation once. Unknown acceptance keeps
  the reservation and original attempt; retries do not submit again or release credits
  merely because the reference subsequently expires.
- Successful delivery requires complete output review for the actual video duration.
  Concurrent finalization settles the same reservation once, and playback is scoped
  to the owner. Shared valid account credits include eligible granted credits; their
  funding source is not treated as evidence of qualified payment revenue.

The added SQL tests use a seven-credit fixture quote solely to test ledger invariants.
It is not a proposed template retail price. A successful fixture ends with 93 available,
zero reserved and seven settled credits from an initial 100; a definite rejection
returns to 100 available; an uncertain submission retains 93 available and seven
reserved without a second attempt.

## Verification executed

The following are distinct scopes in this audit, not totals from prior implementation
or browser runs:

| Scope                                                                   | Passing cases |
| ----------------------------------------------------------------------- | ------------: |
| AI source builders and transport                                        |           160 |
| Template configuration and output contracts                             |            30 |
| Source database admission/review unit tests                             |            10 |
| Source jobs unit tests                                                  |            19 |
| Source API unit tests                                                   |             6 |
| SaaS template draft/payment-return unit tests                           |            10 |
| **Unit total**                                                          |       **235** |
| Video admission SQL                                                     |           127 |
| Video execution SQL                                                     |            70 |
| Video fulfillment SQL, including source Original Rap                    |            24 |
| Source admission/claim/recovery SQL, including original Spin references |            11 |
| **SQL total**                                                           |       **232** |

The first SQL run had four failures because the restarted isolated PostgreSQL used
Asia/Shanghai while those existing fixtures depend on UTC. After setting the test
database default to UTC and verifying it on a new connection, all four failing cases
passed. Fulfillment and source-template suites subsequently passed in full with the
new coverage. This was a test-environment correction, not a production code fix.

The audit expanded two regression files:

- `packages/database/prisma/queries/media/video-source-template.integration.test.ts`:
  preserved Spin scene hash/order, both role reviews, claim once, replaced/expired
  reference rejection, one-time failure release and unknown-submission retention.
- `packages/database/prisma/queries/media/video-v1-fulfillment.integration.test.ts`:
  a preserved source Original Rap snapshot through output review, concurrent
  finalization, ledger invariants and owner playback.

Database workspace TypeScript, formatting and lint for both changed tests, and
`git diff --check` passed. No unrelated browser run or full build was added for this
test-only follow-up. The audit itself required no business-code change.

## Remaining availability and inherited limitations

1. The preparer still emits 12 disabled/internal provisions with empty target prices
   and reference approvals. Original bytes are available, but actual target private
   `MediaAsset` bindings, authorization/review evidence and verified price rows are
   required before opening generation. Source credit denominations are not EzPic
   retail prices.
2. Source Hotel Lobby lacks a frozen explicit prompt/output-duration contract and
   remains blocked by `VIDEO_TEMPLATE_OUTPUT_CONTRACT_REQUIRED`. The existing EzPic
   Hotel Lobby is a separate product and is not a substitute for that source contract.
3. Flying Car is a legacy sample/inventory entry, outside the source execution keys;
   a working public preview does not make it a working generator.
4. The original Bulin prompt describes replacing the output soundtrack, but no
   corresponding post-generation audio replacement implementation was found in the
   source path. The copied implementation supplies the original reference audio to
   the provider. Exact soundtrack replacement is not an implemented guarantee; this
   audit neither rewrote the prompt nor invented a mixing stage.
5. Without real generation, visual motion, identity fidelity, lip sync, audio output,
   provider acceptance and real costs remain unverified.

## Cleanup and publication

The task-owned PostgreSQL root PID 48316 and all six recorded descendants exited after
a graceful shutdown; port 55432 no longer listened. Test runners exited. The ignored
cleanup record is `.cache/ezrapvideo-template-integration/audit-cleanup.json`.
No worktree was created, and no commit, push or deployment was performed.
