# Source template production configuration and Worker footprint — 2026-11-06

This follow-up checks the production binding inventory and R2 metadata read-only, and
measures local packaging/configuration. It does not deploy, import production material,
call generation/moderation providers, or change production business state.

## Production credentials

Cloudflare settings for both `ezimageai-site-production` and
`ezpic-workflows-workers-production` contain these secret bindings:

- `KIE_API_KEY`, `SEEAPI_API_KEY`
- `WAFFO_MERCHANT_ID`, `WAFFO_PRIVATE_KEY`
- `KIE_WEBHOOK_SECRET`, `VIDEO_SEEAPI_CALLBACK_SECRET`, `SEEAPI_WEBHOOK_SIGNING_KEYS`
- `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_ENDPOINT`, `MEDIA_BUCKET_NAME`
- `VIDEO_RUNTIME_CONFIG`

Both also have `HYPERDRIVE`, `IMAGES`, `VIDEO_MEDIA_BUCKET` and `VIDEO_WORKFLOW`.
`VIDEO_MEDIA_BUCKET` names `ezimageai-media-production`.
No missing binding was found in this checked set. Secret values were not printed or
validated by this inventory; presence does not establish current balance or model access.

## Material location

The source R2 bucket `ezairapvideo-media` exists, with the original effect and rap-style
prefixes. Public previews continue to use existing source R2/static URLs.
EzPic's production bucket exists, but this task has **not** imported its new template
materials there. The completed private-material import used isolated PostgreSQL and MinIO.

The archive contains 38 original files (30 images, eight WAVs), 44,045,146 bytes. The local
import produced 45 template-specific private references totalling 47,005,078 bytes because
shared ramp materials have separate template approval identities. These local fixture
approvals cannot be used for production. The implemented production importer requires
actual target administrator receipts and retains private asset, hash and quota checks.

## Jobs Worker import boundaries

Actual Wrangler dry-run/minified builds use `apps/workflows/wrangler.workers.jsonc`.
Removing the offline archive export and extracting the URL replacement helper removes
unnecessary quotation builders from the frozen-task consumer. Original prompts remain
available to website quotation and are unchanged.

| Import-boundary comparison        |       Before |        After |
| --------------------------------- | -----------: | -----------: |
| Jobs JavaScript bytes             |    3,613,338 |    3,539,925 |
| JavaScript gzip bytes             |      914,249 |      892,735 |
| Total upload gzip, including WASM | 2,066.70 KiB | 2,045.64 KiB |

This isolated comparison saves 73,413 JavaScript bytes (71.69 KiB). It precedes the
separate price-schema change. Neither build includes the approximately 44 MB of material
bytes. The fixed graph excludes offline manifests, original configuration archives and
Flying Car quotation prompt JSON, while retaining runtime transport and review consumers.

`pnpm --filter @repo/workflows test:source-template-bundle` checks these boundaries using
a real current dry-run build. The detailed import-only evidence is in
`.superpowers/sdd/ezrapvideo-template-integration/worker-bundle-audit.md`.

The footprint-audit build, including the price-schema change below, passed the same
boundary regression: **3,541,433 JavaScript bytes**, **893,146 JavaScript gzip bytes**,
and **2,046.17 KiB total upload gzip** including WASM (approximately 2.00 MiB).
Compared with the original baseline, the final JavaScript reduction is **71,905 bytes
(70.22 KiB)**. The small codec overhead is included in this final result.

The subsequent [callback repair](source-template-callbacks-2026-11-06.md) adds the required
addressed callback receivers and confirmation guards. Its report records the newer final
Jobs artifact; the figures above retain the earlier audit's measurement boundary.

## Runtime price configuration

The previous provision format repeated the complete pricing evidence for every option
row. This data is read from the database; it is not embedded in Worker JavaScript.
The new private pricing schema stores one original JSON base string and sparse overrides.
Admission expands only its selected price. It does not change prices, original prompts,
reference material, provider requests or frozen accepted quote evidence.

| Compact runtime JSON            | Before bytes | After bytes |
| ------------------------------- | -----------: | ----------: |
| One Rap provision, 390 prices   |    1,082,110 |     158,824 |
| Spin provision, 360 prices      |    1,000,767 |     151,985 |
| All 16 provisions, 2,342 prices |    6,564,191 |   1,050,286 |

This removes approximately 84% of total provision data. All 2,342 restored price rows
were checked for exact equality, including the complete original `pricingBasis` string.
The base remains a string so PostgreSQL JSONB object key reordering cannot alter the
restored evidence. Legacy full-text prices remain readable; uncommon text/JSON formatting
and one-row cases stay in the old form when dictionary sharing adds overhead.

The original local bundle remains unchanged. The new local output is
`.cache/source-video-templates/local-prepared-bundle.v2-deduplicated.json`; exact size and
round-trip evidence is in `.cache/source-video-templates/pricing-codec-size-report.json`.
Neither file is a production approval or deployment artifact.

Focused regression checks passed: 90 config tests, nine source-admission tests,
14 preparation/apply tests and the real Jobs bundle boundary test. The 2,342-price
round trip also passed after JSONB-style object key reordering. Config, Jobs and scripts
type checks passed; changed codec/tooling files passed formatting and lint checks.

## Release and verification boundaries

Deploy compatible website/jobs consumers before activating provisions, including the
new pricing schema. Apply the source quote constraint migration and use actual production
private-material receipts. Keep compatible accepted-task consumers through rollback/drain.
No new provider secret has been identified as a prerequisite by this audit.

The website's final Worker artifact has not been rebuilt in this check. Existing old
artifacts are not evidence of the current website size; the Jobs measurements above must
not be presented as the total website footprint. A current Linux/OpenNext build and its
existing final-artifact memory checks remain part of release verification.
