# Legacy OpenRouter image-edit benchmark (retired)

## Retirement status

This file preserves the 2026-09-05 OpenRouter route research as historical context. It was retired
from the active EzPic launch contract on 2026-09-07 when new image generation moved to the Kie SKU
catalog.

| Evidence or decision                                  | Status                      |
| ----------------------------------------------------- | --------------------------- |
| Historical OpenRouter public price/schema review      | **COMPLETED 2026-09-05**    |
| Historical adapter/worker compatibility review        | **COMPLETED 2026-09-05**    |
| Paid OpenRouter execution or production certification | **NOT_COMPLETED / RETIRED** |
| Use for new EzPic image submissions                   | **RETIRED**                 |
| Use as Kie SKU price, quality, or launch evidence     | **PROHIBITED**              |
| Real paid Kie 20-cell certification                   | **NOT_COMPLETED**           |

No paid Provider call or human image-quality review was performed for the old report. A historical
request-shape test, dry run, static Trigger task, or public price never proved live OpenRouter
behavior. It also says nothing about Kie's task API, output hosts, billing, latency, recovery, or
image quality.

The old `image-fast` and `image-quality` keys and OpenRouter adapter remain server-side only so
already-frozen historical jobs can be retrieved or reconciled. They are not public catalog products
and are not candidates for a new quote. OpenRouter must stay out of `MEDIA_ENABLED_PROVIDERS`; use
`MEDIA_RECOVERY_PROVIDERS` only while an auditable historical backlog still requires it.

## Historical findings — not current catalog

The following table records what the 2026-09-05 review concluded. These rows must not be copied into
current pricing, capability, smoke, or certification artifacts.

| Historical Provider/model                    | Public cost observed on 2026-09-05 | Historical conclusion                                                                         |
| -------------------------------------------- | ---------------------------------: | --------------------------------------------------------------------------------------------- |
| OpenRouter / `sourceful/riverflow-v2.5-fast` |               1K $0.019; 2K $0.021 | Request/response path appeared locally compatible; real private execution remained unverified |
| OpenRouter / `sourceful/riverflow-v2.5-pro`  |       1K $0.13; 2K $0.15; 4K $0.17 | Request/response path appeared locally compatible; real private execution remained unverified |
| Replicate / `black-forest-labs/flux-schnell` |                   $0.003 per image | Reviewed endpoint was text-to-image and did not satisfy the required edit contract            |
| fal / `fal-ai/flux/schnell`                  |               $0.003 per megapixel | Reviewed root endpoint was text-to-image and did not satisfy the required edit contract       |
| Gemini / `gemini-2.5-flash-image`            |      About $0.039 plus image input | The then-current adapter/worker private-URL contract was incompatible                         |

The OpenRouter $0.023/$0.180 planning ceilings, five/forty-credit weights, top-up assumptions, and
Standard/Quality labels are retired. They remain only inside immutable historical Quotes/jobs and
must not be used to price or certify a Kie task.

## Current Kie replacement contract

The active image catalog/pricing version is `2026-09-07.2`. It contains nine public image products
and 20 legal cells:

| Public product     | Legal settings and EzPic Credits        |
| ------------------ | --------------------------------------- |
| Nano Banana 2 Lite | 1K = 5                                  |
| Nano Banana        | Default = 5                             |
| Nano Banana 2      | 1K = 9; 2K = 13; 4K = 19                |
| Nano Banana Pro    | 1K = 19; 2K = 19; 4K = 25               |
| GPT Image 1.5      | Medium = 5; High = 23                   |
| GPT Image 2        | 1K = 7; 2K = 11; 4K = 17                |
| Seedream 4.5       | Basic 2K = 8; High 4K = 8               |
| Seedream 5 Lite    | Basic 2K = 7; High 3K = 7; Ultra 4K = 7 |
| Seedream 5 Pro     | Basic 1K = 8; High 2K = 15              |

GPT Image 2 1K is sold and must be included in certification. Each model owns its own
resolution/quality/aspect-ratio matrix, and this release fixes output quantity and source-image
count at one. Output format and background are non-billable product-local controls, not extra SKU
cells. If multi-reference Seedream 5 Pro is introduced later, the quote must freeze the reference
count and its provider-price increment rather than treating it as one of these base cells.

Kie certification must use the normal private production path for each exact SKU: quote and frozen
cost, prompt/input moderation, owner-scoped source asset, credit reservation, durable job and Outbox,
Kie submission and same-attempt polling recovery, output-host policy, streamed private transfer,
output moderation, settlement, and immutable ledger result. Required evidence includes terminal
counts, output MIME/dimensions/count, human scoring, p50/p95 latency, retries, uncertain acceptance,
and reconciled Kie billing.

The Kie route gate is catalog-version scoped through
`MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS`. Nothing in this retired file may satisfy that gate.

## Legacy command boundary

The repository may retain the older command for reproducibility:

```bash
pnpm provider:benchmark:image-edit
```

Its dry-run output is a legacy diagnostic only. Do not run it as Kie certification, do not enable an
old OpenRouter submission route to make it pass, and do not attach its output to a Kie launch record.
A Kie paid smoke must use the current 20-cell provider-smoke configuration and the existing private
job/finalization path. Real paid Kie execution remains `NOT_COMPLETED` in this repository.

## Privacy boundary

Source images, prompts, authorization records, asset IDs, signed URLs, raw Provider payloads,
credentials, and individual rating records stay private. Public clients receive only stable product
and SKU keys, supported parameters, and EzPic Credits. Provider/model/cost fields remain
operator-only.

## Sources

Historical sources reviewed 2026-09-05:

- OpenRouter Riverflow Fast: <https://openrouter.ai/sourceful/riverflow-v2.5-fast>
- OpenRouter Riverflow Pro: <https://openrouter.ai/sourceful/riverflow-v2.5-pro>
- OpenRouter FAQ: <https://openrouter.ai/docs/faq>
- Replicate FLUX Schnell: <https://replicate.com/black-forest-labs/flux-schnell>
- fal FLUX Schnell: <https://fal.ai/models/fal-ai/flux/schnell>
- Google Gemini API pricing: <https://ai.google.dev/gemini-api/docs/pricing>

Current Kie sources:

- Kie pricing: <https://kie.ai/zh-CN/pricing>
- Nano Banana 2 Lite: <https://docs.kie.ai/market/google/nano-banana-2-lite.md>
- GPT Image 2 image-to-image: <https://docs.kie.ai/market/gpt/gpt-image-2-image-to-image.md>
- Seedream 5 Pro image-to-image: <https://docs.kie.ai/market/seedream/5-pro-image-to-image.md>
- Kie task detail: <https://docs.kie.ai/market/common/get-task-detail.md>

## Rollback

Retirement changes no immutable historical Quote, job, attempt, reservation, or Ledger row. A
rollback must not reactivate OpenRouter for new submissions. Keep a retrieve-only recovery path only
for already-accepted historical work, and remove it after the backlog is durably drained. Roll back
the Kie catalog only as one compatible set of product/SKU matrices, credit/cost snapshots,
catalog/pricing versions, plan visibility, runtime flags, translations, and tests.
