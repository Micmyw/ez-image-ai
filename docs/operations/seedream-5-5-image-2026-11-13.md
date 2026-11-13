# Seedream 5.5 image integration

Reviewed 2026-11-13. This integration follows the existing MiniMax H3 image path:
one text-to-image or reference-image edit request, one private result, and the
existing quote, moderation, credit, provider-attempt and recovery contracts.

## Research and product presentation

ByteDance's [model page](https://seed.bytedance.com/en/seedream5_5) and
[release post](https://seed.bytedance.com/en/blog/more-realistic-images-more-stable-editing-across-100-rounds-introducing-seedream-5-5)
describe more stable successive editing, native RGBA, finer realistic materials
and improved dense text. These guide the presentation; published supplier
benchmarks are not EzPic test results.

The public `/seedream-5-5` page places the working composer first, followed by
large examples for typography, food photography and infographics, a room-edit
comparison, and a transparent product cutout. The source is credited once as
Kie examples. Prompts and their size, ratio, format and background settings can
be applied directly. Choosing transparency selects PNG without an extra dialog.

The owner authorized Kie materials. The five example outputs and two references
were inspected and converted to WebP display copies with alpha preserved.
The [material record](evidence/seedream-5-5-page-materials-2026-11-13.json)
contains source URLs, source/display hashes, dimensions and exact supplied
prompts. Resolution labels describe source request settings, not the resized
website preview. These are supplied examples, not paid EzPic generations.

Layer decomposition is a separate Kie multi-output API with per-layer billing.
It is outside this MiniMax-style single-image integration and is not advertised
as an available EzPic action.

### Media.io demonstration

The owner subsequently selected the Seedream card from [Media.io's homepage](https://www.media.io/).
Its HTML points to `https://www.media.io/videos/homepage/seedream5-5.mp4` and
`https://images.media.io/homepage/seedream5-5-poster.jpg`. The clip is a pre-rendered
7.018685-second, 1200 × 676, 25 fps H.264/AAC MP4 (773,035 bytes). The pointer,
successive accessory/clothing/color edits, zooms and final title are encoded in
the clip. The webpage's visible-card loading, muted looping video and Swiper
carousel are separate from creation of those images. The exact image-generation
and editing software cannot be established from this public artifact.

The unchanged MP4 and JPEG poster are served locally above the Kie image gallery,
with a short Media.io source link. Native controls retain pause, seeking and audio;
viewport/hidden-tab pausing avoids background playback, manual pause is preserved,
and reduced-motion preference stops automatic playback. No playback permission
dialog or generation action is added. Source hashes and metadata are recorded in
[the demo receipt](evidence/media-io-seedream-demo-2026-11-13.json).

Follow-up validation passed: 49 focused route/material tests, SaaS type-check,
scoped lint/format and the real-browser public spec at 1440px and 390px. Playback
advanced from zero; manual pause survived scrolling away and back; automatic
offscreen pause resumed on return; reduced-motion changes paused playback.
Screenshots are under `output/playwright/seedream-media-io-2026-11-13/`.
All temporary test processes exited. This is local presentation verification;
the demo is neither an EzPic generation receipt nor a live deployment.

## Supplier contract

Sources: [Kie model/pricing page](https://kie.ai/seedream-5-5),
[text-to-image API](https://docs.kie.ai/market/seedream/5-5-text-to-image), and
[image-to-image API](https://docs.kie.ai/market/seedream/5-5-image-to-image).

| Output tier | Text-to-image cost | One-reference edit cost | EzPic credits |
| ----------- | -----------------: | ----------------------: | ------------: |
| 1K          |            $0.0180 |                 $0.0252 |             8 |
| 1.5K        |            $0.0180 |                 $0.0252 |            12 |
| 2K          |            $0.0315 |                 $0.0387 |            20 |

The owner requested higher credit usage above the lowest resolution. 1K stays
at 8 credits; 1.5K and 2K increase to 12 and 20. Default selection is 1.5K.
The first reference also costs $0.0072. Kie credits and EzPic credits are
different units; no recharge discount is assumed. Quotes freeze the selected
operation's supplier cost. Existing accepted quotes and historical prices stay
unchanged.

- Routes: `seedream/5-5-text-to-image`, `seedream/5-5-image-to-image`.
- Prompt: 5–5,000 characters. One output per task.
- Sizes: `1K`, `1.5K`, `2K`; formats: `png`, `jpeg`.
- Background: `auto`, `opaque`, `transparent`; transparency requires PNG.
- Ratios: 1:1, 4:3, 3:4, 16:9, 9:16, 2:3, 3:2, 21:9. Editing also supports
  `auto`; text-only automatic selection resolves to 1:1.
- Supplier inputs: JPEG, PNG or WebP, up to 10 MB each. EzPic uses its existing
  single-reference flow and immutable private-asset authorization.

## Pricing assumptions

Using the [MiniMax margin method](minimax-h3-image-2026-11-13.md), the lowest-price
undiscounted subscription is Max annual: $474 / 36,000 issued credits. Allow
15% supplier contingency, $0.005 / $0.0075 / $0.010 runtime/storage reserve,
$0.0001 per input/output review, and payment/risk allocation of
`(0.06 * planPrice + 0.30) / creditsIssued * imageCredits`.

| One-reference edit | Planned cost | Revenue allocation | Contribution |  Rate |
| ------------------ | -----------: | -----------------: | -----------: | ----: |
| 1K, 8 credits      |     $0.03418 |           $0.10533 |     $0.06477 | 61.5% |
| 1.5K, 12 credits   |     $0.03668 |           $0.15800 |     $0.11174 | 70.7% |
| 2K, 20 credits     |     $0.05471 |           $0.26333 |     $0.19266 | 73.2% |

These are budgeting scenarios before taxes, fixed costs and acquisition spend,
not invoice-reconciled profit. Gifted credits are not payment revenue.

## Integration and release boundaries

- Product: `image-seedream-5-5`; SKUs: `seedream-5-5-1k`,
  `seedream-5-5-1-5k`, `seedream-5-5-2k`.
- Catalog and pricing version: `2026-11-13.2`.
- New model follows existing premium subscription access. Free H3/Lite access,
  sign-in credits and frozen Image Pass coverage remain unchanged.
- Readiness flag: `MEDIA_SEEDREAM_5_5_IMAGE_ENABLED`; deployment overlay:
  `MEDIA_SEEDREAM_5_5_IMAGE_BUILD_ENABLED`.
- Deploy compatible jobs/provider consumers before enabling website producers.
  Disable new admission while retaining accepted-task consumers during rollback.
- No database migration or payment SKU is required.
- Clean public route is indexable and included in discovery/sitemaps. Private
  query states and untranslated locale views retain the existing indexing policy.

The owner authorized Git publication and production deployment on 2026-11-13.
Release proceeds with the jobs consumer first, then website model admission.
Local checks below do not establish a live deployment or paid generation result.

## Local verification

### Shared lighting and Seedream typography

`packages/ui/components/glow-surface.tsx` exports `GlowSurface` through both its
direct module and `@repo/ui`. It has no model, generation or account dependencies.
Use `variant="ambient"` for a background or `variant="frame"` for a thin border;
`tone` accepts `aurora`, `violet` and `cyan`, `intensity` accepts `subtle`, `normal`
and `strong`, and `radius` accepts a CSS border radius. Set `interactive={false}`
for static light. Custom colors may override `--glow-primary` and
`--glow-secondary` through CSS.

```tsx
<GlowSurface variant="ambient" tone="aurora" intensity="strong">
	<YourWorkspace />
</GlowSurface>
```

Seedream uses the ambient variant around the shared `ModelHero` and existing
workspace, and the frame variant around its demo. Pointer movement updates CSS
coordinates at most once per animation frame; decorative layers never receive
pointer events or move the contents. Touch and reduced-motion preferences retain
static lighting, while keyboard focus still highlights the input. No homepage
headings, model access rules or generation behavior change.

The follow-up typography uses `DisplayTitle` from `packages/ui`: `lead`, `accent`,
`edition`, optional `descriptor`, accessible `label`, and `refract` / `alloy`
variants. `as` supports H1/H2/H3. The accent reads `GlowSurface`'s normalized
`--glow-progress`, with static styling outside that surface and under reduced
motion. Seedream combines a clean prefix with an italic, iridescent suffix;
MiniMax uses a stronger metallic suffix and H3 edition mark. `ModelHero` owns the
model copy and facts; the UI primitive contains no model configuration.

The shared main composer puts Prompt ideas before the text field in both DOM and
visual order. The field grows up to 320px and scrolls longer text, without a native
resize handle beside Generate. The trigger retains keyboard focus styling and
its existing popover behavior.

The typography/composer follow-up passed 91 focused route, example and registered
form tests. Both public model journeys passed at 1440px and 390px, covering
pointer-responsive wordmarks, Prompt ideas placement and selection, bounded
long-text scrolling, model settings and video playback. Final captures are under
`output/playwright/model-wordmarks-final-2026-11-13/`. A playback follow-up retains
queued automatic-pause counts until the corresponding media events arrive;
subsequent play events no longer clear an outstanding automatic pause. The final
browser run passed manual-pause preservation and offscreen resume.

Local visual follow-up: UI and SaaS TypeScript checks passed; 49 focused route
and example tests passed. The Seedream Playwright journey passed at 1440px and
390px, including pointer light, stable typing geometry, keyboard navigation,
reduced motion, touch-pointer suppression, settings, video controls and page
overflow. Screenshots are in
`output/playwright/seedream-lighting-2026-11-13/`. Catalog and availability were
mocked; this did not submit a paid generation. Temporary test processes exited
and the local test port was clear after completion.

### Shared gallery prompt preview

`modules/image-tools/components/ExamplePromptActions.tsx` now owns the prompt
actions on both model galleries. Cards retain direct Use this prompt and a quiet
View prompt control; long text no longer expands the gallery. The Base UI dialog
shows the matching artwork, model/resolution, scrollable original prompt, copy
feedback and fixed actions. Reference downloads are available beside the image
inside the preview. The phone layout keeps the image compact and the actions
visible. Escape returns focus to the invoking card; applying waits for dialog
closure, preserves the example's existing settings and focuses the editor.

The prompt event helper remains shared with direct card actions. No generation is
submitted by viewing, copying or applying a prompt. The public page and image
indexing contracts remain unchanged. After reviewing the revised local design,
the owner resumed publication and deployment on 2026-11-13.

Gallery-preview verification: 49 focused route/material tests and SaaS TypeScript
checks passed. Both model browser journeys passed at 1440px and 390px, including
unchanged card height, Escape/focus return, actual clipboard copy, visible actions
while reading, applying after closure, reference links and matching Seedream
settings. Scoped lint/format and diff checks passed. Screenshots are in
`output/playwright/model-prompt-preview-final-2026-11-13/`. Temporary test
processes exited and port 3319 was clear. No paid generation was submitted.

### Earlier integration checks

- AI catalog/provider and H3 regression: 153 tests passed.
- Configuration, plan eligibility, flags and Image Pass: 251 tests passed.
- API quote/authorization/create/retry/guest/admin: 219 tests passed.
- Transactional admission: 48 tests passed.
- Jobs dispatch/executor: 106 tests passed; the final model-scoped dispatch guard
  passed its 33-test suite again.
- Web-host flags/profiles/bindings: 359 tests passed.
- SaaS route/indexing/navigation/editor/example materials: 244 tests passed;
  its 21 build-unit checks also passed.
- AI, config, API, database, jobs, web-host and SaaS type checks passed.
  Scoped formatting/lint, translation client messages and diff checks passed.
- Playwright public-page test passed at 1440px and 390px: default 1.5K/12 credits,
  all seven example/reference images, keyboard comparison, 2K/20-credit poster
  preset, 1K/8-credit transparent preset, JPEG/PNG background transitions and
  no horizontal overflow. Browser fixtures mock public catalog/availability;
  no paid generation or authenticated production behavior is claimed.
- Screenshots: `output/playwright/seedream-5-5-2026-11-13/public-routes-Seedream-5-5-aa170-works-on-desktop-and-mobile-public/seedream-5-5-1440.png`
  and `seedream-5-5-390.png` in the same directory.
