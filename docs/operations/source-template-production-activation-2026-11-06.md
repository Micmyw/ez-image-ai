# Source template production activation — 2026-11-06

## Incident

The website and jobs deployment at `ac6e4ae9` and the
`20261106060000_source_video_template_quote_pending_evidence` migration succeeded,
but production had zero active `media.source-template.*.provision` records.
`sourceTemplateAccess` therefore returned unavailable and disabled customer uploads.
Deployment and migration success did not establish customer availability.

## Recovery

The project owner had already authorized original-source reuse, implementation,
publication and completion of production setup. The existing import, prepare and
apply procedures are used with the production database and private R2 bucket
`ezimageai-media-production`. No new media or replacement prompts are generated.

- Source commit: `75c06e3b5f8141ac45a3bd37fe494b44cc8f7769` in `ez-airapvideo`.
- 38 original files: 44,045,146 bytes. Template-specific immutable identities create
  45 private objects: 47,005,078 bytes. Every object is read back and SHA-256 checked.
- Apply the recorded `source-material-inspection-2026-11-06-v1` under the owner's
  release authorization. Preserve the real inspector and method: 30 visual image
  inspections and eight WAV hash/header checks, with no auditory review. This is
  administrator application of recorded Codex inspection, not a supplier verdict
  or a claim that the account holder manually inspected every file.
- Reuse authorization is the user's current-chat instruction, not independent
  copyright ownership verification. Frozen built-in references have no scheduled
  expiry; the required timestamp field uses `9999-12-31T23:59:59.999Z`. Explicit
  revocation, object identity and current evidence checks remain authoritative.
- Prepare all 16 execution configurations for `authenticated` access, covering
  2,342 existing price combinations. Reuse the recorded provider prices and
  conservative complete-cost budgets; do not invent EzPic prices from source-site
  consumer credits. The nine discovery cards still group source execution variants.
- The one-off remote management client uses a 180-second transaction timeout for
  the full reference-validation/application batch. Its initial 20-second dry run
  expired without applying configurations. Normal application request limits stay
  unchanged.

Private receipts and operation logs are in the ignored
`.wrangler/source-template-release-20261106/activation-*.json` files. The helper
permits HTTP only to the production R2 endpoint. No generation provider request,
paid moderation request, Outbox scan or credit mutation is part of activation.

The directory no longer renders the hard-coded “Being prepared” metadata. Creator
availability remains server-derived; temporary outage copy no longer suggests
that another output approval is required to launch.

## Release acceptance

The production apply completed for all 16 configurations with bundle hash
`83862174eec0cb80fd4efa18c3a4d3b60fb253b66d031bdcf73d8aea2604159b`.
The actual signed-in 58th Floor page subsequently returned HTTP 200 with
`available: true` and no reasons. Both photo upload controls were enabled, its
unavailable notice disappeared, and the existing Person + pet / 2K draft stayed
intact. The quote button correctly remained disabled while the required photos
were empty. This observation did not submit a quote or generation.

Do not certify customer access from a green build or migration status. Verify:

1. Active, enabled, authenticated provisions exist for every source execution key;
   all bound private assets and current evidence pass the existing apply validator.
2. The deployed website returns successful access checks and enables photo upload
   in the actual signed-in customer UI. Check both generation-provider families.
3. Record the exact UI/configuration evidence separately from generation evidence.
   This recovery must not submit a generation or charge credits for verification.

For a future asset or price change, repeat the explicit import/prepare/apply
process after compatible consumers are deployed. Publishing application code does
not create production material approvals or bootstrap database provisions.
