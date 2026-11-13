# Homepage photo quick starts

The homepage presents four outcome-led cards immediately below the composer: Christmas
wallpaper, old-photo restoration, birthday card and Kung Fu Cat video. This replaces the
large Christmas-only promotion. The existing image gallery and deeper video recommendations
remain available. The Create workspace does not repeat this discovery row.

## Design and interaction

Use the existing Plus Jakarta Sans family and studio palette: ink `#f6f2fb`, muted text
`#b7acbf`, lavender `#c9b7ff`, card surface `#1c1625`, and warm photo-paper `#bda482`.
Large photographic covers, small Image/Video labels and a full-card action communicate the
result before the user has to choose a model. Desktop uses four columns, narrow layouts two.
Cards have visible keyboard focus and respect reduced motion. The separate preview popup
described below plays only its currently selected sample.

Restoration and birthday selections apply translated editable prompts to the mounted editor.
Uploaded photos, model, output settings and active job identities are retained. Selecting an
image idea in video mode returns to the already-mounted image panel. Existing Generate
handles the request without another confirmation or sign-in interception.
Christmas and cat-video cards open their existing creators.

An editor acknowledges the cancelable prompt event only when its listener is mounted. Until
then, and for modified/new-tab clicks, ordinary links open `/create?example=restore-photo` or
`/create?example=birthday-card`. `lang` stays explicit on translated public links. Known preset
keys resolve to translated prompts; arbitrary URL text is never treated as a preset.

The initial preset is subordinate to an existing recovered draft, following the existing
example flow. It does not rewrite an accepted request. Selection in the editor invalidates
only the existing editable action through its normal handler.

## Artwork

- Christmas uses the existing `/images/christmas/globe.webp` artwork.
- Restoration uses the existing `/images/effects/1980s-ai-photo/family-snapshot-v3.webp`
  vintage portrait as the subject illustration; it is not a before/after result claim.
- Birthday uses `/images/quick-start/birthday-card.webp`, produced with the built-in imagegen
  tool and encoded as a 640px WebP. Prompt: a realistic golden retriever in a lavender party
  hat behind a pale pink cake with three candles; lavender/yellow confetti, soft periwinkle
  studio background, natural fur and editorial lighting, portrait composition, no text/logo.
  This is editorial cover artwork, not evidence from the production generation provider.
- Kung Fu Cat uses a same-origin copy of the existing template catalog's original poster at
  `/images/quick-start/kung-fu-cat.webp` and its canonical creator. The poster source is
  `https://media.ezairapvideo.com/effects/kung-fu-cat-ai/kung-fu-cat-h3-v2/b050627d030550ff97e40d0bf0ac5ae3f168cb553cf85862d26f5274749c7e79-poster.webp`.

## Measurement and release

Each card emits `homepage_idea_selected` with a bounded `homepageIdea` key through the existing
consent-aware, lazy analytics transport. First-party ingestion stores that key in the existing
event diagnostics JSON. Navigation never waits for measurement. This records
entry clicks; the existing generation/payment events retain their original contracts, so card
clicks alone do not establish attributed conversion or revenue.

The homepage Title/H1/Description from the November 13 observation remain unchanged. This
separate body-layout change is user-authorized; record its eventual deployment time when
interpreting that observation. Local changes and mock browser tests are not a deployment.

## Local verification — November 13, 2026

- 123 SaaS tests passed across preset handoff, homepage rendering, client translation scope,
  all four locales, registered form behavior and growth analytics.
- 13 API ingestion tests passed, including persistence of each of the four idea keys.
- 7 Playwright checks passed: 1440/390/320px layouts, German direct preset links,
  keyboard selection from video mode, Christmas creator navigation and the floating editor.
- SaaS and API type checks, affected-file lint/format checks and `git diff --check` passed.
- Browser checks used local guest/catalog fixtures; no paid provider generation was performed.
  Screenshots are in `output/playwright/homepage-quick-starts/`. All tracked test processes
  exited and the isolated test port 3247 was released. No commit, push or deployment performed.

## Image-first dynamic showcase — November 13 revision

The user requested a Media.io-style homepage popup, then clarified that EzPic is primarily an
image editor: the preview must feature images, open smoothly and avoid a gallery of narrow
portrait videos. Live competitor observations remain in
[`homepage-showcase-research-2026-11-13.md`](homepage-showcase-research-2026-11-13.md).

### Content and visual treatment

The popup now uses a wide 16:9 canvas, up to 920px wide, with a dark studio footer. Three photo
ideas precede a single landscape video. The old three-video campaign was a local prototype;
its portrait MP4s/posters are removed from the public bundle.

1. **Watercolor:** the existing kingfisher photo/painted pair fills the canvas. A one-time
   reveal demonstrates the difference; the native range control works with pointer, touch,
   Home/End and arrow keys. Both assets are decoded before the automatic entrance.
2. **Vintage portrait:** the original portrait and the actual approved family-album output
   appear as two complete photographic prints. Their different compositions are shown side
   by side rather than aligned as if their pixels matched.
3. **Christmas:** three existing wallpaper artworks form a wide triptych, with a short
   staggered entrance. The action opens the existing wallpaper creator.
4. **Music video:** the existing Green Booth Freestyle sample is natively 16:9. The entire
   frame fits the canvas without stretching, trimming performers, or blurred sidebars.
   Only this selection loads a video. Pause, optional sound, progress and retry stay available.

Image actions have per-idea labels. Watercolor and vintage prompts are editable and translated
in all four locales. They apply to the mounted editor after the closing transition, preserving
uploads, the selected model and task identities. A selection from video mode returns to the
existing image panel and then focuses the prompt. If no editor acknowledges it, the normal
`/create?example=watercolor|vintage-photo` destination is used. Modified clicks keep native
new-tab behavior. The existing quick-start cards share the same prompt-selection hook.

### Motion and dismissal

The feature overrides the shared dialog's layered slide/zoom keyframes with Base UI's actual
`data-starting-style`/`data-ending-style` lifecycle. Entrance combines a 24px upward settle,
0.965-to-1 scale and opacity (420ms / 280ms); exit uses a smaller 10px settle over 220ms / 180ms.
The dim backdrop fades without an expensive full-page blur. Scene changes use a 300ms fade.
After their images load, vintage previews hold the original for 1.8 seconds and reveal the
result over another 1.8 seconds. Christmas images fade in over 1.8 seconds each with one-second
offsets, completing the sequence in 3.8 seconds. Both then remain still until the visitor
chooses another idea; there is no timed slide advance. Reduced motion shows them immediately.
Media remains mounted during exit; video pauses immediately and its source is released when
unmounted. Focus returns without scrolling after ordinary dismissal, or moves into the editor
after a photo action. Reduced motion skips transitions and the comparison sweep.

The invitation opens after 1.4 seconds and initial-image decoding for a fresh homepage visitor,
once per release under `ezpic:homepage-showcase:2026-11-13-v2`. An interaction cancels it.
Editor/job/payment links and `/create` are not interrupted. The homepage **Explore new ideas**
button always reopens it. X, Escape and backdrop dismiss it. Viewing never requests a quote,
upload, login, purchase or generation.

### Click measurement

Explicit thumbnail/arrow clicks emit `homepage_idea_preview_selected`; the popup Create CTA
and quick-start cards emit `homepage_idea_selected`. Both carry only the public
`homepageIdea` and `homepagePlacement` (`showcase` or `quick-start`) identifiers, plus the
existing selected status and analytics session. Opening the popup or revealing an image
does not count as a click. Repeat clicks remain separate events. Tracking is asynchronous
and uses the existing analytics preferences and transport; it never delays the product action.

The **Homepage idea clicks / 首页玩法点击** table in `/admin/analytics` reports preview and
Create click totals and distinct browsers per idea and entry. It uses the report's 24-hour,
7-day or 30-day range and source/device filters, excluding internal traffic. Browser counts
are deduplicated by the existing session hash, not asserted to be cross-device people.
Older card events without a placement remain `quick-start`; no historical popup events are
invented. The existing `growth_event.diagnostics` JSON stores these dimensions; no database
migration is needed. This local change must be published before new production clicks appear.

### Asset provenance

- Watercolor uses the existing 960px variants registered in
  `modules/landing/lib/image-to-image-artwork.json`. This pair was made with the built-in image
  tool as an illustrative style comparison, not verified EzPic provider output. The original
  edit instructions are in `public/images/image-to-image/provenance.json`.
- Vintage uses `public/images/effects/1980s-ai-photo/input-adult-v1.webp` and
  `family-snapshot-v3.webp`. The output has actual product-generation evidence in
  `docs/product/evidence/1980s-ai-photo-2026-09-29.json#attempt-4`. The original is fictional;
  this is an eighties restyling idea, not restoration of a genuine historical photo. The new
  prompt is an editable starting point; its shorter translations are not new tested presets.
- Christmas uses existing street, globe and pet editorial artwork, documented in
  `docs/product/christmas-wallpaper-artwork.json`.
- Green Booth uses the original catalog sample
  `https://media.ezairapvideo.com/effects/green-booth-freestyle-ai/green-booth-h3-v3/b6ed3c7d6ba7506be3a6be32ebed727b7c88c01e7aca684582ad9cad9e385250-green.mp4`.
  Its same-origin preview is `public/videos/homepage-showcase/green-booth-freestyle.mp4`,
  960 × 540, 10.041667 seconds, 975449 bytes, H.264 CRF 25/AAC 64 kbps with fast-start metadata.
  Its WebP poster is the first frame. Motion/audio are retained; no Media.io media is copied.

The visible labels are **Photo idea** and **Video template**. Only the vintage image above has
product-generation evidence. No additional paid generation or production deployment is
represented by this local design iteration.

### Local verification of this revision

- 44 focused SaaS tests passed for preset selection, four-locale messages, the unchanged
  homepage experiment copy and the shared prompt handoff. SaaS type-check and affected-code
  lint passed.
- 12 Playwright scenarios passed: image-first previews at 1440/390/320px, actual landscape
  video decoding, no MP4 request before selecting Video, sound/pause/source cleanup,
  keyboard comparison, centered entrance with intermediate opacity frames, image retention
  through exit, unchanged scroll after dismissal, photo handoff from video mode retaining an
  upload and focus, translated direct presets, dismissal persistence/backdrop reopening,
  reduced motion and replay after a failed media load, plus the five existing quick-start
  cases. These use local public-catalog fixtures, not provider generation.
- The phone thumbnail layout received a final focused responsive recheck. Evidence and the
  new actual browser recording are under `output/playwright/homepage-showcase-v2/`.
- The slower photo reveal follow-up passed four focused browser checks (1440/390/320px and
  reduced motion), including the original-photo reading beat, staggered Christmas reveal,
  and a five-second completed-image hold without advancing. The replacement recording is
  `output/playwright/homepage-showcase-v2/homepage-showcase-slower-demo.mp4`; each middle
  photo idea is shown for about ten seconds at the actual interaction speed.
- Work remains local. No Git publication, provider generation or deployment occurred.
- The click-report follow-up passed 48 focused tests across SaaS rendering/handoff, API
  ingestion and report aggregation, plus one browser journey capturing the actual local
  transport. It verifies all four popup identifiers, separate card/CTA/preview events, no
  automatic-display clicks, and continued creation when the analytics request fails.
  API storage is mocked in unit coverage; this is not production ingestion evidence.
