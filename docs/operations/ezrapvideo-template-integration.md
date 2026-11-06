# Ezrapvideo source templates

Local implementation branch: `codex/ezrapvideo-templates`. No publication, deployment,
target production configuration writes or paid generation is authorized by this implementation task.

## Source and boundaries

The source is `ez-airapvideo` commit `75c06e3b5f8141ac45a3bd37fe494b44cc8f7769`.
`packages/ai/media/rap-templates/source-manifest.json` records copied files, hashes,
effective prompt revisions and original reference material identities. Source JSON/documents
marked `verbatim` are excluded from formatting. The original TS builders retain their logic;
imports and integration boundaries are adapted to EzPic.

The source production configuration was read without modification. The six effective configured
prompts are archived with hashes; 19 effect reference files and 19 Flying Car reference files were
copied without transformation. Four original Flying Car prompt selections are executable. Neither source enablement nor
source sample publication proves EzPic reference approval or generation acceptance.

Original Rap and four style routes, Bulin 47 and Spin Me Round use their original SeeAPI
construction. 58th Floor, Green Booth Freestyle, Kung Fu Cat and Paws at You use the original
Kie H3 reference requests. Flying Car also retains its original H3 requests, with the user subject
first, then the ordered original scene frames and audio. There is no replacement scene generation
stage or model fallback. Source Hotel Lobby has a complete provider-owned template interface:
`executionContract: "provider-owned-template"`, null prompt and null requested duration. Its
provider body omits prompt/model/duration, both input photos remain reviewed, and output review
uses the actual measured duration. This corrects the initial migration's erroneous missing-contract
block. Existing EzPic Hotel Lobby, Raindance and Rumpelstiltskin identities are unchanged.

## Configuration and reference preparation

Private per-template provision values use existing `RuntimeConfigOverride` rows under
`media.source-template.<templateKey>.provision`. Do not put a large manifest into Cloudflare
environment bindings. The newest active version is authoritative for new admission. The quote
freezes provision identity, exact request, reference identities, output contract and price;
accepted requests continue from their frozen snapshot after configuration changes.

New preparation uses private pricing schema 2 to share repeated pricing evidence through
one original JSON base string and sparse overrides. Only the selected quote row expands
to its original full evidence; existing full-text provisions and accepted snapshots remain
compatible. Deploy schema-capable consumers before applying this compact configuration.
See the [footprint check](source-template-worker-footprint-2026-11-06.md) for exact sizes
and the separate production material-import boundary.

The import, preparation and apply commands perform no generation. Keep credentials in the
normal private server environment; `--environment-file` supplies pricing configuration only.
Use target-specific administrator application receipts referencing the actual source inspection,
not fabricated SeeAPI tasks or imported local-test approvals:

```powershell
pnpm video-templates:test-config
pnpm video-templates:import --receipts .wrangler/source-video-templates/approved-materials.json --maximum-bytes 100000000 --output .wrangler/source-video-templates/import-preview.json
# In the intended authorized target, add --apply to import exact bytes and persist private bindings.
pnpm video-templates:import --receipts .wrangler/source-video-templates/approved-materials.json --maximum-bytes 100000000 --output .wrangler/source-video-templates/imported.json --apply
pnpm video-templates:prepare --receipts .wrangler/source-video-templates/imported.json --environment-file .wrangler/source-video-templates/pricing-environment.json --output .wrangler/source-video-templates/prepared.json
pnpm video-templates:apply --bundle .wrangler/source-video-templates/prepared.json --target .wrangler/source-video-templates/target.json --administrator "TARGET_ADMIN_ID" --environment-file .wrangler/source-video-templates/pricing-environment.json --output .wrangler/source-video-templates/validated.json
# After compatible consumers are deployed, the same apply command with --apply writes the bundle.
```

Import validates all original hashes before writes, checks the administrator and explicit target,
reserves owner storage under the existing fence, conditionally writes a private object and checks
the complete stored hash before committing its MediaAsset and approval. Lost responses retain the
same reserved identity for recovery. Source inspection evidence and administrator application are
distinct from supplier moderation; customer uploads retain their normal SeeAPI review. Local
fixture receipts cannot activate staging or production. Shared curved-ramp source packs have
separate template-specific approval records; no existing approval is overwritten.

Preparation now covers 16 execution keys and all supported priced option tuples. It includes both
Spin scenes and each Flying Car frame/audio pack. Complete target receipts and prices produce
`READY_TO_APPLY` with authenticated generation enabled; missing data produces explicit blockers,
not a permanently empty price/reference scaffold. Output files remain private/ignored and are not
overwritten. Apply reconstructs the source/price bundle, checks its hash and target, revalidates all
references in the target database, and atomically creates versioned audited overrides. Reapplying
the same active bundle is unchanged.

`packages/config/source-template-pricing.server.ts` uses the observed SeeAPI supplier-credit rules
and public H3 per-second/extra-image tariffs. It includes each customer image review, sampled
video review, Waffo text review where applicable, runtime/storage and payment/failure budgets
before the existing shared-credit retail calculation. Hotel is priced per generation; its 32-frame
review budget is not an invented output duration. Flying Car charges the two extra reference
images for ramp modes or one for fleet modes. The default SeeAPI conversion uses the highest
unit price among the observed purchasable Pay Once packs (USD 299 / 30,000 supplier credits),
clearly labelled as a public conservative budget, not an account invoice. The source site's
consumer credits are never treated as EzPic retail prices. No native-sound request adds audio
review or post-generation audio mixing.

`https://ezpic-template.example/...` archive values are opaque identities, never fetch authority.
Every required reference must bind to its private MediaAsset. Provider submission replaces the
identity with a signed private access URL; unresolved archive identities are rejected.

## Execution and access

The API accepts public template keys, supported options and opaque input asset IDs. Client
payloads do not select providers or pass arbitrary remote URLs. Image-result handoff reauthorizes
the owner and image state. A successful image result does not bypass video input review.

The existing video quote/job/reservation/VideoExecution transaction and native `VIDEO_WORKFLOW`
remain authoritative. Each of zero to three user roles has durable moderation identity and
uncertain-submission recovery; all required roles must pass before provider submission.
Reference identity, expiry and approval are rechecked at admission and submission. Source providers
retain their exact request and retrieval semantics. Unknown acceptance holds the same task and
credits; it does not authorize paid replay or automatic provider substitution.

Source-template generation and per-role input review now wait for authenticated callbacks,
without scheduled provider-status polling. The source's optional `callback_url` / `callBackUrl`
is supplied at submission. SeeAPI keeps its documented raw-body signature; Kie H3 keeps the
source URL-capability contract, bound to the exact attempt. A durable, job-addressed inbox
wakes only that native Workflow. Each distinct callback authorizes one authenticated read;
no callback body supplies business status, task identity or a result URL. No Outbox event or
global callback scan is created. Missing callbacks, interrupted confirmation reads and expired
deadlines retain the existing reservation for operational review. Ordinary video retains its
existing protocol. See [callback repair and verification](source-template-callbacks-2026-11-06.md).

UI drafts, pending confirmations and query caches are account/template scoped. History and private
playback require the current owner even if generation is closed. The public directory contains
only explicit public source sample URLs. Homepage recommendations are server-rendered lazy posters;
the directory permits one preview at a time. A fine mouse pointer starts a muted preview on hover;
leaving unloads it. Explicit playback supports sound, touch and keyboard use. Reduced-motion
visitors keep explicit playback without hover autoplay. Hidden or offscreen previews unload.
New template routes remain noindex until their target content/acceptance review is complete.

### Public preview inventory follow-up (2026-11-06)

Read-only inspection of Airap's R2 object prefixes, D1 configuration names/task aggregates and
source static assets found Flying Car's original public poster/video under
`https://ezairapvideo.com/flyingcar/templates/v1/curved-ramp/`. Both return HTTP 200 and their
downloaded bytes match the source checkout: `reference-04.jpg` is 57,507 bytes with SHA256
`15ce82c4bcf46444419e575d72c1fd75891901288cc87ebf85b3aa326c75d9cc`; `preview.mp4` is
3,231,853 bytes with SHA256 `d89b11c56082e39c25b97a0d7d01cc0d0be800908dfa1d4833fe023253699a59`.
They are reused directly by the directory and detail page; generation remains unavailable.

The directory now renders nine original preview cards and three compact links for the existing
EzPic Hotel Lobby, Raindance and Rumpelstiltskin tools. No corresponding public sample for those
EzPic variants was found in the inspected Airap sources. Source Hotel Lobby keeps its separate
original sample and identity. Missing samples never create an empty poster frame; existing tool
links still participate in search and category filters. No customer output was made public.

The [presentation correction](../product/video-template-ux-2026-11-06.md) groups Flying Car's
four source execution choices under that one discovery entry, adds hover previews and
source-based explanatory content, and preserves the original prompt-to-reference bindings.

## Validation and release

The [production activation follow-up](source-template-production-activation-2026-11-06.md)
records the missing production-provision incident and the explicit material/configuration
application. A successful application deployment does not itself activate these templates.

The [completion follow-up](ezrapvideo-template-completion-2026-11-06.md) supersedes the initial
audit's three migration limitations. It records real local material import and provision checks,
without a paid generation or production release.

The [2026-11-06 source and billing audit](ezrapvideo-template-audit-2026-11-06.md)
records prompt/material checks, the offline option matrix, SQL lifecycle regressions
and the remaining availability/audio limitations. It contains no live-generation evidence.

See the implementation plan's evidence ledger for executed local checks. Provider fixture tests,
local SQL and browser fixtures prove only their exercised paths. They do not prove live generation,
provider acceptance, production readiness or cost. Deploy compatible jobs and website consumers
before enabling provision rows. To close new generation, disable the provision while retaining
the compatible accepted-snapshot consumer and owner-scoped history until existing tasks drain.
