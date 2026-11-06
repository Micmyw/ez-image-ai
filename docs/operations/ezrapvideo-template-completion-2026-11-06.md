# Source template completion — 2026-11-06

The user asked to resolve the three limitations in the initial audit while preserving
all original prompts/materials/generation methods and making no real generation call.
The missing local implementation paths are now complete. Production has not been changed.

The subsequent [production binding and Worker footprint check](source-template-worker-footprint-2026-11-06.md)
records the actual secret-binding inventory, distinguishes source R2 from local imports,
and measures the additional runtime import/configuration reductions.

The later [callback repair](source-template-callbacks-2026-11-06.md) corrects an additional
integration omission: source-template completion previously depended on timed status reads.
The new source path uses authenticated callbacks and stops at its deadline without polling.

## Corrected contracts

Source Hotel Lobby never required a customer prompt or fixed requested duration. Its
original SeeAPI endpoint owns both. The earlier generic target validation incorrectly
treated that legal request as incomplete. The strict `provider-owned-template` variant
now preserves null prompt/requested duration and omits prompt, model and duration from
the provider body. Both input photos still require individual review. A distinct
`no-user-prompt` receipt replaces an inapplicable text-review call; ordinary templates
retain Waffo review. Output inspection must provide real MP4 duration before complete
output review and settlement. The existing 30-second review capability remains enforced.

All four Flying Car contracts are copied from fixed source commit
`75c06e3b5f8141ac45a3bd37fe494b44cc8f7769`: curved-ramp showcase V5, curved ramp V6,
fleet side V1 and fleet front V1. Each preserves its original TXT prompt, ordered
reference frames, audio, H3 reference mode and 768P/2K settings. Ramp modes request 15
seconds, fleet modes seven. The browser supports a single person/animal/object subject;
it does not force a portrait interpretation. Shared ramp previews are labelled as shared
source samples. Existing EzPic effect identities remain independent.

Bulin already has a complete reference-audio generation request. Its source prompt
mentions soundtrack replacement, but its source pipeline directly stores the provider's
video, without a later mixing stage. Faithful integration preserves that exact flow.
The absence of a new mixing stage is no longer treated as a migration blocker. Exact
audio reproduction or generated visual fidelity was not tested or newly promised.

## Materials and complete pricing

All 38 original files remain byte-identical to the archive: 30 images and eight WAVs.
Images were visually inspected; WAV hashes and headers/durations were checked. The
inspection receipt explicitly states that it is not an auditory review, a human
administrator approval or a SeeAPI verdict.

The new importer combines an explicit administrator application receipt with this
source evidence. It checks the intended database/storage target and original hashes,
reserves owner storage, performs conditional private object writes, verifies complete
stored bytes, and commits the MediaAsset/approval under existing locks. It keeps source
inspection separate from supplier moderation and from customer-upload review. Lost
write responses keep their identity and quota for recovery. Test receipts are rejected
outside the local target; fixture approvals are never deployment materials.

Pricing now covers every exposed tuple, including SeeAPI model tiers, Hotel's per-run
price and H3's additional-image fees. Ramp requests contain seven total images and add
USD 0.04; fleet requests contain six and add USD 0.02. The default SeeAPI conversion is
the highest observed paid Pay Once unit price, USD 299 / 30,000 supplier credits, as an
explicit conservative public budget. This is not the source site's consumer-credit
denomination or a claim about the target account's invoice. Input/output/text review,
runtime/storage and payment/failure budgets feed the existing shared-credit formula.
Waffo's official free-beta prompt-review documentation was rechecked read-only; that
observation is not a permanent free-price guarantee.

Preparation produces all 16 enabled/authenticated provisions when the target data is
complete. It enumerates 2,342 distinct price tuples and binds both Spin scenes and all
Flying variants. Apply verifies the source-derived bundle and current database approvals
in one transaction, then writes versioned audited configuration. It is dry-run by default
and idempotent for the same active bundle.

## Executed evidence

These checks use mocks or isolated local services. No generation/moderation provider was
invoked; external API access was limited to read-only pricing/documentation/source queries.

| Check                                                    | Observed result  |
| -------------------------------------------------------- | ---------------- |
| Original builders and transports, including Hotel/Flying | 202 tests passed |
| Source pricing and existing retail regressions           | 128 tests passed |
| Hosted/output configuration                              | 44 tests passed  |
| Jobs source/template regressions                         | 54 tests passed  |
| Video MP4 inspection                                     | 21 tests passed  |
| Source admission/configuration SQL                       | 13 tests passed  |
| Fulfillment SQL, including source/hosted cases           | 25 tests passed  |
| Immutable material storage unit regressions              | 6 tests passed   |
| Import/preparation/apply/read-only-price CLI command     | 17 tests passed  |
| Public browser regression                                | 9 tests passed   |

Database unit suites additionally covered source review, atomic bundle application and
material reservation/commit. Focused frontend tests covered drafts, payment return,
rendering and indexing; suite reruns overlap, so they are not added to a combined total.
AI, config, database, jobs, API, storage, SaaS and scripts type checks passed. Changed
files passed formatting/lint and whitespace checks. An independent read-only review
found no confirmed remaining admission, material or billing defect in the reviewed paths.

Real local PostgreSQL and MinIO checks used the archived bytes:

- 38 unique original files became 45 template-specific private reference records,
  totalling 47,005,078 stored bytes; the two ramp contracts have separate approvals.
- Repeat import created neither duplicate assets nor additional quota. A simulated
  lost response after a real successful PUT recovered the same object after full hash
  verification. Aggregate quota rejection occurred before the storage write.
- A complete local bundle was `READY_TO_APPLY`: 16 enabled authenticated provisions,
  2,342 nonempty exact price rows and 45 private references.
- Apply dry-run created no overrides/audits. Apply created 16 overrides and 16 audits.
  Reapply returned `UNCHANGED`, preserving record IDs, versions and counts.
- The provision runner allowed only the isolated PostgreSQL socket; no HTTP, HTTPS,
  TLS or fetch provider request occurred. The normal network guard also protected
  focused test runs.

Private local evidence paths:

- `.superpowers/sdd/ezrapvideo-template-integration/source-material-inspection-2026-11-06.json`
- `.superpowers/sdd/ezrapvideo-template-integration/source-material-local-integration-report.json`
- `.superpowers/sdd/ezrapvideo-template-integration/source-template-local-provision-report.json`
- `.cache/source-video-templates/local-prepared-bundle.json`
- `.cache/source-video-templates/pricing-environment.json`
- `.cache/ezrapvideo-template-integration/browser-flying.log`

## Release boundary

The complete local bundle contains explicitly local fixture ownership and approvals;
the target checks prevent its use in production. For an authorized release, use the
same implemented import/preparation/apply commands with actual target administrator
application receipts, storage and pricing configuration, after compatible jobs/website
consumers and the source quote constraint migration are deployed. No real video output
is required to import these existing materials or apply the configuration.

No real user credit balance, source production state or target production state was
changed. No commit, push or deployment was performed. Live provider acceptance, motion,
lip sync and final sound remain outside this no-generation verification scope.

All temporary test runners exited. Task-owned PostgreSQL PID 32792 and its descendants,
MinIO PID 356 and its supervisor PID 275, and their recorded Windows launchers exited.
Ports 55432, 59000, 59001 and 3349 no longer listened. Cleanup evidence is
`.cache/ezrapvideo-template-integration/completion-cleanup.json` and
`completion-minio-cleanup.json` in that directory. No worktree was created.
