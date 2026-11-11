# GPT Image 2.6: Kie contract verification

Checked: 2026-11-11. Public documentation and page metadata only; no paid generation,
account-specific access check, payment, deployment or live output verification.

The November 5 finding that Kie did not yet list 2.6 is obsolete. Its
[model page](https://kie.ai/gpt-image-2-6) now lists Flare, Sunburst and Economy.

## Model and parameter contracts

All six models submit through `POST /api/v1/jobs/createTask`, with a server-selected
`model`, `input`, and optional `callBackUrl`.

| Variant  | Text model                             | Reference-image model                   |
| -------- | -------------------------------------- | --------------------------------------- |
| Flare    | `gpt-image-2-6/flare-text-to-image`    | `gpt-image-2-6/flare-image-to-image`    |
| Sunburst | `gpt-image-2-6/sunburst-text-to-image` | `gpt-image-2-6/sunburst-image-to-image` |
| Economy  | `gpt-image-2-6/economy-text-to-image`  | `gpt-image-2-6/economy-image-to-image`  |

These are Kie IDs, not OpenAI's dot-separated IDs.

### Flare and Sunburst text generation

The [Flare schema](https://docs.kie.ai/market/gpt/gpt-image-2-6-flare-text-to-image.md)
and [Sunburst schema](https://docs.kie.ai/market/gpt/gpt-image-2-6-sunburst-text-to-image.md)
declare:

- Prompt: 1–32,000 characters. The application's narrower moderation limit can remain.
- Resolution: `1K`, `2K`, `4K`; default `1K`.
- Quality: `low`, `medium`, `high`, `xhigh`, `max`, `auto`; default `medium`.
- Complexity: `low`, `medium`, `high`; default `high`.
- Output: `png`, `jpeg`, `webp`, `gif`, `svg`; default `png`.
- Aspect ratios: `auto`, `1:1`, `3:2`, `2:3`, `4:3`, `3:4`, `5:4`, `4:5`,
  `16:9`, `9:16`, `2:1`, `1:2`, `21:9`, `9:21`, `3:1`, `1:3`.
- `moderation`: `auto` or `low`. Explicit `auto` preserves the intended stronger
  provider setting rather than accepting Kie's `low` default.

The `4K` name does not mean 4096×4096: square maps to 2880×2880 and 16:9 maps to
3840×2160. Square 1K/2K map to 1024×1024/2048×2048.

GIF-specific fields: integer `frame_count` 2–16 (default 9),
`frame_duration_ms` 20–2000 in 10-ms increments (default 200), and text-only `size`
(per frame). `512x512` works across 2–16 frames; `768x768` supports at most 12.
The sprite sheet has a 3840-pixel edge limit and an 8,294,400-pixel limit.
Do not substitute `aspect_ratio` or `resolution` for GIF frame dimensions.

SVG-specific field: `svg: { model: "gpt-5.6-luna" }` is the documented default.
Alternative authors are `gpt-6-sol` and `gpt-5.6-terra`. Do not send GIF fields
with SVG, or `svg` with other formats. JPEG/WebP compression fields belong only
to those respective formats.

### Reference-image differences

Both [Flare image-to-image](https://docs.kie.ai/market/gpt/gpt-image-2-6-flare-image-to-image.md)
and [Sunburst image-to-image](https://docs.kie.ai/market/gpt/gpt-image-2-6-sunburst-image-to-image.md)
explicitly support GIF and SVG. They use `input_urls` with up to 16 JPEG/PNG/WebP
references; the public playground lists a 30 MB per-file ceiling. The existing
application's single-reference and 25 MiB limits remain valid narrower limits.

These image-to-image schemas have `additionalProperties: false` and **do not
declare `size`**. Their GIF examples omit it. Do not copy the text-to-image
`size` field into image-to-image requests without further provider evidence.
Masks are forbidden for GIF/SVG. The initial integration need not expose masks
or markup to provide reference-guided generation.

### Economy differences

[Economy text-to-image](https://docs.kie.ai/market/gpt/gpt-image-2-6-economy-text-to-image.md)
is 1K-only, prompt 1–20,000 characters, and supports PNG/GIF. Frame count is a
**string enum**: `auto`, `4`, `9`, `16`, `25`, `36`, `64`, not every integer 2–64.
No quality, resolution, complexity, SVG or GIF size field is declared.
Frame duration prose allows `auto` or 20–2000 ms, while its schema says `number`;
an explicit integer in 10-ms steps avoids that contradiction.

[Economy image-to-image](https://docs.kie.ai/market/gpt/gpt-image-2-6-economy-image-to-image.md)
supports **PNG only**. Therefore Economy cannot provide image-to-GIF or SVG.
Both Economy variants allow ratios `auto`, `1:1`, `16:9`, `9:16`, `3:2`, `2:3`,
`21:9`, `4:3`.

## Provider pricing and retail quotes

Kie's page publishes the same token rates for all four Flare/Sunburst routes:

| Usage              | USD / million tokens |
| ------------------ | -------------------: |
| Text input         |                 4.50 |
| Cached text input  |                1.125 |
| Image input        |                 7.20 |
| Cached image input |                 1.80 |
| Image output       |                27.00 |

SVG adds authoring charges to image charges:

| SVG author      | Input USD / million | Output USD / million |
| --------------- | ------------------: | -------------------: |
| `gpt-5.6-luna`  |                0.18 |                 1.08 |
| `gpt-6-sol`     |                1.80 |                 9.00 |
| `gpt-5.6-terra` |                1.80 |                10.80 |

Economy's page metadata and variant pricing card say 5 Kie credits ($0.025) per
1K image. There is no explicit GIF/frame-price breakdown in the inspected
documentation. Do not advertise a guaranteed $0.025 64-frame GIF cost based only
on that image price. Top-up bonuses are not an integration pricing assumption.

There is no request-side maximum output-token or USD-budget field in these Kie
schemas. Consequently, the documentation does not establish a guaranteed
maximum total cost for a Flare/Sunburst/SVG task.

The [official OpenAI image guide](https://developers.openai.com/api/docs/guides/image-generation)
links an output-token calculator. Its current GPT Image 2.6 estimator produces
the following values; the dollar column applies Kie's output-token rate:

| Square size | Medium tokens / USD | High tokens / USD |
| ----------- | ------------------: | ----------------: |
| 1024×1024   |    1,449 / 0.039123 |  1,756 / 0.047412 |
| 2048×2048   |    2,944 / 0.079488 |  3,568 / 0.096336 |
| 2880×2880   |    4,894 / 0.132138 |  5,930 / 0.160110 |

These are **estimates for output only**, not total task prices or hard upper
bounds. They exclude text, reference images and SVG authoring. They do not
establish an Economy GIF price. The calculator's linked source at verification:
`https://developers.openai.com/_astro/GptImageTokenCalculator.react.7TppeEsP.js`.

Recommended application contract: freeze a fixed retail credit quote before
admission using explicit quality/size/format/frame choices; keep an explicitly
labelled internal provider-cost estimate separate from that retail charge;
record actual Kie consumption after authenticated retrieval; preserve existing
settlement and uncertainty rules. Historical image-pass coverage and retail
prices must remain frozen. Do not copy GPT 2.5's fixed route costs as verified
2.6 prices, or treat an internal estimate as a provider-enforced spending cap.

### Initial application pricing choices

These are local product decisions, not additional provider claims. The first
contract fixes Flare at medium quality and Sunburst at high quality, limits
prompts to 4,000 characters, and offers SVG/GIF on the 1K SKU only. GIF uses
2–16 frames; Economy is not enabled by this implementation.

| Variant  | Retail credits for 1K / 2K / 4K | Internal USD allowance for 1K / 2K / 4K |
| -------- | ------------------------------- | --------------------------------------- |
| Flare    | 20 / 40 / 80                    | 0.09 / 0.18 / 0.36                      |
| Sunburst | 25 / 50 / 100                   | 0.115 / 0.24 / 0.49                     |

SVG adds 20 retail credits and $0.10 to the internal allowance. GIF retail credits
and allowance scale by the documented 512px sprite-sheet area relative to a
1024px square: 2× for 2–8 frames, 2.25× for 9, 3× for 10–12, and 4× for 13–16;
retail credits round up to integers. Playback speed does not change the quote.
The $0.005-per-credit planning floor motivates these allowances but does not
guarantee a margin or cap actual token consumption. Account credit eligibility,
frozen quotes, settlement and actual-consumption accounting remain authoritative.

## Results, failures and documentation conflicts

[Get Task Details](https://docs.kie.ai/market/common/get-task-detail.md) uses
`GET /api/v1/jobs/recordInfo?taskId=...`. It returns JSON-string `resultJson`
containing `resultUrls` for image/media output, and `creditsConsumed` for actual
Kie credit consumption. One Kie credit is $0.005 at the base rate. Generated
files are retained by Kie for 14 days; copy accepted output into existing private
storage rather than treating provider links as permanent customer assets.
No separate SVG/base64 result envelope is documented for these Kie routes.

The existing callback-as-wake, authenticated retrieval, output validation,
moderation and financial recovery protocols remain necessary. A failure string
does not itself prove zero consumption or safe paid resubmission.

Conflicts to handle conservatively:

- The SVG examples still name `gpt-5.4-mini`; follow the declared author enum and
  default instead.
- Background descriptions disagree about transparent GIF support. PNG supports
  transparency clearly; use opaque/default background for the first GIF/SVG
  contract rather than promising unsupported combinations.
- OpenAI's guide retains 2–64 GIF wording, but its current
  [generation API reference](https://developers.openai.com/api/reference/python/resources/images/methods/generate)
  says 2–16. Kie's Flare/Sunburst schema is also 2–16; only its separate Economy
  text route enumerates up to 64.
- The [official Flare model page](https://developers.openai.com/api/docs/models/gpt-image-2.6-flare)
  confirms `gpt-image-2.6-flare` and rates of $5 text input / $8 image input /
  $30 image output per million tokens. These official rates are not the Kie
  price contract.

No provider task was submitted during this verification. Documented support
does not certify the configured account, returned file validity, processing
runtime compatibility or successful paid generation.
