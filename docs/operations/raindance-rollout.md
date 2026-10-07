# Raindance trend guide and template rollout

The English canonical `/blog/raindance-ai-trend` combines an indexable original
prompt guide with the existing private photo-to-video workbench. It is registered
in the Blog pipeline, public navigation and sitemap. `job`, `mode` and non-English
language views are noindex and canonicalize to the clean guide. Hotel Lobby keeps
its existing sample-quality publication gate.

## Product contract

- `raindance-solo` accepts one adult photo, bound to both existing internal roles;
  `raindance-duo` accepts two photos with fixed left/right roles. Both use immutable
  `raindance-2026-10-07.1` scene and motion snapshots.
- Nano Banana 2 Lite 1K creates an original sunset-pier scene; Seedance 1.5 Pro
  creates the final 5-second, 720p, 9:16 silent MP4. The feature does not reproduce
  lyrics, licensed audio, an artist's voice or exact lip synchronization.
- Private uploads, immutable quote/confirmation, eligible paid credit allocation,
  one reservation, two-stage moderation, uncertainty holds, Workflow recovery and
  private final playback use the existing template pipeline. The additive
  `20261007030000_raindance_template_effects` migration expands the existing SQL
  template-ID CHECK to Hotel Lobby, Raindance Solo and Raindance Duet. All other
  shape/state checks, immutable identities and private boundaries remain intact.
  It adds no tables, columns, parallel ledger or global Outbox dispatch.
- The existing approved Hotel Lobby full-cost budgets, evidence expiry and minimum
  3x revenue policy apply to the identical model/options/stage envelope. The new
  price snapshot is `raindance-cost-2026-10-07.1`. The reference quote is 69 credits;
  clients always display the current server quote. Solo retains the conservative
  two-role budget. Neither Hotel Lobby nor ordinary-video test funding is inherited.
- Prompts are free to read/copy. Generation requires login and eligible credits.
  Drafts and lost-response recovery are isolated by account and effect. Switching
  Solo/Duet never submits a paid request.

## Private configuration and deployment order

Before deploying either target, verify the intended production database and its
Prisma migration history, then apply `20261007030000_raindance_template_effects`
with `prisma migrate deploy` over verified TLS. Confirm that it is the only pending
migration and inspect the validated live CHECK afterward. The transaction changes
only the effect allowlist, uses a 3-second lock timeout and preserves existing rows.
Cloudflare builds perform read-only migration status checks and refuse pending
migrations. Keep this compatible expanded constraint during application rollback.

`RAINDANCE_RUNTIME_CONFIG` is an additive build-only JSON overlay. Its allowlist is
exactly `RAINDANCE_ENABLED`, `RAINDANCE_ACCESS` and
`RAINDANCE_ACCEPTED_TEMPLATE_VERSION`. It merges over the build runner's current
private `VIDEO_RUNTIME_CONFIG` after the Hotel Lobby patch; neither existing
variable is replaced with a local snapshot. The merged pack must fit 5,000 UTF-8
bytes. Credentials, ordinary access, funding and price policy cannot be changed by
this overlay. The build-only overlay is stripped before packaging child processes
and runtime artifacts.

For the authorized authenticated beta, the final private build value on both
`ezimageai-site-production` and `ezpic-workflows-workers-production` is:

```json
{
	"RAINDANCE_ENABLED": "true",
	"RAINDANCE_ACCESS": "authenticated",
	"RAINDANCE_ACCEPTED_TEMPLATE_VERSION": "raindance-2026-10-07.1"
}
```

The version records approval of this beta deployment policy, not proven output
quality. Keep website `RAINDANCE_ENABLED=false` for the initial release, deploy the
compatible background receiver first, and verify its commit and live version.
Then enable and deploy the website at the same reviewed commit. Both enabled
builds preflight the complete Solo and Duet price and model contract. Existing
media/video switches, provider eligibility, safety and runtime readiness still
apply. Missing or malformed access stays closed. Existing ordinary video and Hotel
Lobby permissions do not widen.

To close new admissions, change only `RAINDANCE_ENABLED` to `false` in both build
overlays and redeploy. Keep the compatible receiver and frozen execution snapshots
until accepted and uncertain orders drain. An older binary cannot parse Raindance
snapshots; follow [video drain/rollback](video-v1-rollout.md) before reverting it.
Do not resubmit uncertain paid attempts or delete private assets to roll back.

## Content and asset provenance

The guide covers four approaches, original copyable prompts with sentence-level
explanations, photo choices, common failures, duet setup, TikTok audio/AI labeling,
and the distinction between Raindance's sunset pier and generic rain-dance effects.
Primary references are linked on the page. It makes no search-volume, ranking or
free-generation promise.

`apps/saas/public/images/blog/raindance-pier.webp` was generated for this page with
the built-in image tool on 2026-10-07 and encoded to WebP at 1536x1024. It depicts an
empty wooden pier at sunset and is explicitly labeled editorial AI artwork, not a
generated video sample. It is not provider acceptance, identity-retention, playback
or model-output-quality evidence. No source-person photos or licensed music are
published by this release.

## Verification boundaries

Focused contracts cover independent access, strict inputs, frozen template/price
versions, draft/payment-return isolation and additive Worker policy transport.
Browser tests exercise anonymous SEO, responsive layout, actual prompt copying,
Solo/Duet uploads, quote/confirmation, history navigation and lost-response replay
with API fixtures. Real PostgreSQL suites exercise one-asset/two-role admission,
idempotent reservation and the complete Workflow through final settlement and
private playback authorization; external providers/storage remain mocked.

Run SaaS Vitest, Next generation and Playwright sequentially because they share
`.source`. CI separately verifies production builds, final workerd artifacts,
fresh migrations and database invariants. Record deployment IDs, exact commit and
live HTML/sitemap/assets after release. These checks do not establish real paid
generation or visual output quality; that requires separately recorded live
provider acceptance and authorized samples.
