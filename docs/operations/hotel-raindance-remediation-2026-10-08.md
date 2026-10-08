# Hotel Lobby / Raindance remediation — 2026-10-08

## Scope and baseline

Independent branch `codex/hotel-raindance-remediation` starts at fetched main
`291be3ced4018d7ce0b697b73a4e1903591b03dc`, which contains production baseline
`1e09de497839c2c816313e72489c38660f4df200`. No push or deployment is part of this task.
Existing noindex, generator UI, duration, annual pricing and auth-session changes are
already in the base and were not rewritten.

## Fixed sign-in navigation

The desktop header, visitor sidebar and mobile navigation now share a small sign-in
link. Hotel Lobby and Raindance return to their exact local route. A single valid
job ID and an explicit Raindance `solo`/`duo` mode are retained. Arbitrary query
parameters, asset URLs, nested redirects, duplicate values and malformed IDs are
dropped. An ID in a return URL grants no job access; existing owner checks remain.

Only the small effect-specific link reads search parameters inside its own Suspense
boundary. Other public pages keep their existing `/login` behavior and rendering.
The link remains an ordinary document navigation so account locale initialization
is preserved. Existing authentication methods continue to use the existing safe
redirect validation.

A stored Raindance Duet preference is made explicit in the URL during restoration.
The initial effect uses `router.replace(..., {scroll:false})`: native history
patching is not necessarily installed when child hydration effects first run.
Real Chrome exposed this timing problem during implementation; after the fix,
displayed Duet, URL `?mode=duo`, and header return URL agree. Explicit modes and
existing job URLs take priority over a stored preference.

## Raindance incident: verified memory exhaustion; not yet a demonstrated allocation fix

Authenticated Cloudflare Workers Logs matched the reported Ray exactly:

| UTC / route                                      | Ray                | Outcome          | HTTP | CPU / wall ms |
| ------------------------------------------------ | ------------------ | ---------------- | ---- | ------------- |
| 12:30:30.451 `/blog/raindance-ai-trend`          | `a475282bdd5ffac2` | `exceededMemory` | 503  | 3321 / 3886   |
| 12:30:31.066 `/api/rpc/videoV1/catalog`          | `a475283ca89bfac2` | `exceededMemory` | 503  | 0 / 1189      |
| 12:33:27.356 `/blog/raindance-ai-trend?mode=duo` | `a4752c8b0be6fac2` | `ok`             | 200  | 1997 / 2096   |

All three used `ezimageai-site-production`, version
`4aa80d15-c36b-45b4-bffa-c891b56c2b95`. Deployment annotations map it to
`1e09de49`, deployed 12:19:26.929 UTC. The same version was still current at the
14:28 UTC read. A narrow log query from 12:19:26 to 14:20 UTC returned the two
memory failures above; this is an observed retained-log result, not a population
failure-rate estimate.

The exact outcome rules out describing this incident as established CPU exhaustion.
Concurrent catalog failure is relevant because Worker memory is shared per isolate,
but it does not identify the allocating module. No heap profile or allocation stack
was available. Increasing a CPU timeout is not an evidence-based repair for this
event. Main already includes `0c7f3eeb` public-session import optimization; it was
not deployed in the observed incident version. It must be measured after integration
before claiming the incident fixed. No duplicate session changes were made here.

Reference: [Cloudflare Worker limits and memory outcomes](https://developers.cloudflare.com/workers/platform/limits/).
Read-only query IDs: `raindance-incident-ray-readonly`,
`raindance-window-readonly`, `raindance-memory-scope-readonly`; all used `dry:true`.
No log sharing, Worker settings or deployments were changed. Local evidence stores
only timing, route, outcome and version; request headers/IPs/cookies are excluded.

## Real test status and cost

The latest user instruction revoked audio testing: **silent tests only**. Actual
video submissions **0 of 2**, image submissions **0**, known spend **USD 0**.
The task-local persistent ledger is `task-7/evidence/test-ledger.json`.
Failed or ambiguous paid submissions must consume an attempt; query an original
task before any further action. No automatic retry, third video, recharge or other
agent's generation is permitted. Both planned runs remain unsubmitted.

Exact candidate video model is `bytedance/seedance-1.5-pro`, image-to-video,
duration 5, aspect ratio `9:16`, `fixed_lens:true`, `generate_audio:false`.
The scene model is `nano-banana-2-lite`, 1K, `9:16`, one scene per run, two
ordered authorized adult inputs for Hotel and Raindance Duet.

| Candidate                            | Two videos | Two scene images | Supplier subtotal | Approved moderation budget estimate | Estimated supplier + moderation |
| ------------------------------------ | ---------: | ---------------: | ----------------: | ----------------------------------: | ------------------------------: |
| 480p5 silent, separate test variant  |    $0.0875 |          $0.0400 |           $0.1275 |                             $0.0428 |                         $0.1703 |
| 720p5 silent, formal effect contract |    $0.1750 |          $0.0400 |           $0.2150 |                             $0.0428 |                         $0.2578 |

Video and image prices were checked on Kie's official pages on October 8:
[Seedance](https://kie.ai/fr/seedance-1-5-pro),
[Nano Banana 2 Lite](https://kie.ai/nano-banana-2-lite).
No top-up bonus discount is assumed. Moderation uses the existing approved
conservative budget: six image checks × $0.0051 plus two 5-second final checks ×
$0.0061. Text moderation's budgeted zero is temporary; these are estimates, not
new quotes or settled fees. Any necessary charge remains inside the user's $10
total cap and existing authorized service balances.

The formal effect quote/admission/execution/output snapshots enforce 720p and
`sound:false`; schema 1 is five seconds, newer schema 3 supports ten. 480p must not
be injected into that contract. The ordinary catalog lists 480p, but that alone is
not an authorized, funded full effect test route. No new test bypass was installed.
The previously investigated audio alternative is cancelled: no production audio
contract, pricing or safety-policy change was made.

### Execution blockers

1. Production Chrome confirmed Raindance Duet shows **69 required, 0 eligible,
   391 account-total credits**. The formal effect flow cannot currently submit
   this user's order. No account, member status, credit lot, payment receipt or
   operator-funding configuration was changed. No upload/quote/confirm was sent.
2. No confirmed authorized adult source photos were supplied or found in the
   scoped repository evidence. `fixtures/image-edit-benchmark/manifest.json`
   contains placeholders with authorization `pending`; the existing Raindance
   asset is an empty-pier editorial illustration, not two identity references.
   A file being present or a competitor publishing a clip is not permission to
   send it to a provider. No competitor video was downloaded or uploaded.

The next legitimate execution requires authorized adult source assets and an
already lawful funded entry. The normal route is sealed upload → input moderation
→ complete-order quote → confirmation/reservation → scene → scene moderation →
one video submit → original-task polling → output moderation/settlement/private
download. A separate 480p operator route would need to be positively established
before use and must be labelled a test variant, not a formal 720p acceptance.

## Quality gaps and acceptance criteria

Parent-supplied competitor research distinguishes scene recreation from reference
motion, lyric synchronization and source-photo transitions. Kavel's Hotel approach
uses two portraits and an orange studio; Raindance uses a pier reveal. Kapwing's
reference-based Hotel workflow and Media.io's multishot identity mapping require
different inputs and capabilities. Those reports are comparison context, not our
quality evidence. No competitor result is represented as an EzImageAI sample.

Both reserved runs must be scored independently on:

| Dimension        | Evidence required                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Scene            | Hotel orange studio + one suspended microphone; Raindance wooden pier, sea horizon and sunset                            |
| Identity         | Compare input, prepared scene and frames at 0/1/2/3/4/end seconds; score each adult separately                           |
| Left/right       | No swaps, blending, third person or role collapse throughout the clip                                                    |
| Action           | Hotel left gesture/right response then right lead; Raindance small gesture/reaction and brief glance                     |
| Timing           | Actual five-second duration; coherent start, exchange and finish without abrupt truncation                               |
| Lips/rhythm      | Do not award lyric/choreography reproduction from scene similarity; the current preset does not support exact lyric sync |
| Transition       | Current template starts in the prepared scene; no built-in source-photo-to-pier hard-cut pass may be claimed             |
| Audio            | Latest test requires silence; inspect tracks and audible playback; audio capability remains untested                     |
| Technical result | Probe dimensions/aspect/duration/codec/tracks, retain job/task IDs and settlement evidence, record defects               |

All actual quality scores remain **NOT_RUN**. Silent five-second ambience can test
scene/identity/light action; it cannot validate a full dance, exact duet or original
song reproduction. Public samples remain blocked until real successful outputs,
material/model evidence, rights for publication and exact template version are
verified. No fabricated `samples` or `qualityRuns` were added.

## Validation

The original header bug was reproduced by three failing regression cases while
the other 16 existing StudioShell cases passed. Focused regression subsequently
passed 110 tests (9 files, final run 14:43 UTC). Scoped lint and the website
TypeScript check passed. Local Prisma and Next route types were generated; the
initial type check's missing Next `PageProps`/`LayoutProps`/`RouteContext` errors
were resolved by that generation. No production build or Worker deployment was
performed. No real database or service credentials were used. All local test
processes load `tests/video-v1/no-paid-network.mjs` and disable generation.

Real Chrome against the isolated local Next site verified: explicit Duet header,
Solo switch, Duet switch, restored saved Duet, actual `/login` navigation carrying
Duet, and Hotel job return dropping an injected external redirect. New password,
OAuth or magic-link authentication was not submitted. Production read-only checks
establish the credit gate and incident, not deployment of this patch.

Remaining release work: integrate the independent commit, profile/measure the
memory issue on the integrated build, and resolve the test material/funding
blockers before consuming either reserved video attempt.
