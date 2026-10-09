# Video output quality warnings

Candidate policy, 2026-10-09. No migration, deployment, retrospective job repair or paid
generation is performed by this change. Prices, accepted request snapshots and safety
profiles remain immutable.

## Delivery boundary

| Condition                                                                                                                | Previous behavior                          | Candidate behavior                                                                               |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Duration differs by more than 250 ms                                                                                     | Parser/config/storage/finalization failure | Store actual duration and `DURATION_MISMATCH`; required visual review covers the actual duration |
| Audio present with sound disabled                                                                                        | Parser/config failure                      | Preserve the audio and report `UNEXPECTED_AUDIO`                                                 |
| Requested audio absent                                                                                                   | Allowed, no notice                         | Preserve the video and report `MISSING_AUDIO`                                                    |
| Exact pixel target or frozen minimum differs                                                                             | Config/storage/finalization failure        | Preserve the measured pixels and report `RESOLUTION_MISMATCH`                                    |
| Aspect ratio differs by more than 2.5%                                                                                   | Config/storage/finalization failure        | Report `ASPECT_RATIO_MISMATCH`                                                                   |
| Positive output duration below the old 1.75 s delivery minimum                                                           | Finalization/playback failure              | Eligible only after review evidence covers its actual duration                                   |
| Corrupt/truncated/empty MP4, invalid dimensions or track identity, unsupported codecs/track layout, byte/metadata limits | Blocked                                    | Unchanged                                                                                        |
| Unsafe download host/redirect, changed checksum/ETag/bytes, missing object                                               | Blocked                                    | Unchanged                                                                                        |
| Missing, incomplete, uncertain or rejecting NSFW evidence                                                                | Blocked/held                               | Unchanged; an actual file over the review service's 30 s / 100 MB limits remains blocked         |
| Historical audio review requirement                                                                                      | Retained                                   | Retained; never rewritten to `not_requested`                                                     |
| Wrong owner, invalid reservation, stale attestation, concurrent/replayed settlement                                      | Guarded                                    | Unchanged                                                                                        |

Resolution warnings use the existing documented pixel mapping, frozen template target or
application minimum. Labels without a verified pixel target are displayed beside actual
dimensions; no new pixel matrix is invented. The known Kling Pro square documentation
conflict remains unresolved, but an otherwise valid 1440 × 1440 result is no longer failed
because the saved target is 1080 × 1080.

The measured duration is the maximum of the movie and media-track header durations so a
shorter movie header cannot shorten required review coverage. The production MP4 inspector
validates bounded container structure and supported metadata;
it is not a full codec decoder. Existing test fixtures with synthetic media bytes prove
structural and transaction behavior only. Separate offline decode checks on the two original
sample videos are evidence for those files, not a universal playback guarantee.

## Data and client behavior

`completeVideoOutputStorage` computes `stageData.outputSpec.report` from the stored asset's
actual metadata and accepted request. It is saved alongside asset ID, checksum and ETag.
Public projection validates the report and its matching stored measurements; arbitrary
provider metadata and private identities are not exposed. Ordinary get/list receipts and
template get/list receipts return the same safe report. The UI shares `VideoOutputDetails`.
Old receipts without a report retain their state; the template fallback labels its values
as requested settings instead of claiming fixed actual pixels.

The parser, both streaming/recovery checks, database storage completion and finalization
retain integrity checks but do not use quality differences as failure codes. The existing
READY/SUCCEEDED transition and original reserved credit settlement remain in one transaction.
Playback still independently verifies ownership, immutable content and required moderation.
No new queue, retry, regeneration, price adjustment, audio stripping or transcoding is added.
Historical FAILED/RELEASED jobs are not revived or charged again.

Character likeness, motion and scene fidelity have no online semantic delivery gate in this
implementation. No detection or quality acceptance is claimed for them. Public example
publication checks remain separate and unchanged.

## Request contract evidence

The dated `packages/ai/media/catalog/fixtures/kie-video-output-parameters-2026-10-09.json`
contains 16 freshly retrieved official Kie request schemas with source URLs and SHA-256.
All implemented model/mode selections are checked against these schemas. The ordinary
submission tests run the real request adapter with a mocked HTTP boundary and assert that
explicit `sound: false` / `generate_audio: false` survives persisted JSON input, serialization,
accepted replay and uncertain replay. Each case sends once. Existing scene-template and
reference-template tests keep explicit silent requests and supplier NSFW checks enabled.

Seedance 1.5 and 2-family audio defaults make omission different from explicit `false`.
The historical Hotel Playground saved parameters omit the audio field, but those saved
parameters are not an original HTTP capture. They cannot prove what the supplier received
or establish that it ignored an explicit silent request. No adapter parameter defect was
found in this audit. No new paid call was made to test supplier behavior.
