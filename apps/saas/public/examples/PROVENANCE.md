# EzPic public example provenance

All SVG files in this directory were authored specifically for EzPic in this repository on
2026-08-25. They are original geometric vector illustrations assembled from simple shapes and
gradients; they do not copy third-party assets, code, copy, layout, or branding.

The files may be used and modified in EzPic product and marketing surfaces. They contain no third-
party photography, logos, people, testimonials, or customer work. `studio-before.svg` and
`studio-after.svg` deliberately reuse the same illustrated objects to demonstrate the comparison
control. The five `edit-*.svg` files illustrate categories of edit instructions; they are not AI
Provider outputs and are not evidence of a particular model's quality, latency, resolution, or
commercial-use terms.

## Interactive prompt gallery (2026-08-31; expanded 2026-09-05)

The twelve `case-*.webp` files were created specifically for EzPic with the built-in image-generation
tool, then resized and encoded as WebP assets for this repository. They are original
inspiration imagery, not copied from any third-party product or asset. They are also not EzPic model
outputs, customer work, or evidence of EzPic model quality. The landing page repeats that distinction.

The original generated PNG files remain in the task's Codex generated-image directory; the product
uses only the optimized WebP derivatives below:

As of 2026-09-08, the gallery renders each WebP at its intrinsic width-to-height ratio in a responsive
masonry layout. Keep these dimensions in sync with `ShowcaseSection.tsx` when replacing an asset;
do not crop existing landscape or square compositions to fill a portrait card. The twelve existing
assets are unchanged by this display adjustment.

- `case-mediterranean-room.webp`: sunlit Mediterranean living room; editorial interior photography;
  limewash, warm oak, linen, olive and terracotta; wide room view; no people, text, logos, or watermark.
- `case-cobalt-product.webp`: unbranded cobalt perfume bottle on sculptural sand plaster and shallow
  reflective water; premium product photography; portrait framing; no label text, logo, or watermark.
- `case-emerald-fashion.webp`: adult street-fashion portrait in a deep emerald technical jacket after
  rain; authentic skin and fabric texture; portrait crop; no brand marks, text, or watermark.
- `case-blue-hour.webp`: coastal mid-century motel and vintage convertible at cobalt blue hour with
  warm amber windows and wet reflections; no readable signage, text, logos, or watermark.
- `case-citrus-editorial.webp`: citrus tart on lavender ceramic, coral linen, and a plum surface;
  premium editorial food photography; no hands, text, logos, or watermark.
- `case-paper-train.webp`: red alpine railway rendered as layered handcrafted paper-cut art with
  visible fibers and dimensional shadows; no text, logos, frame, or watermark.
- `case-lunar-greenhouse.webp`: moonlit glasshouse with translucent foliage, sparse bioluminescent
  flowers, damp stone, and restrained violet light; no people, text, logos, or watermark.
- `case-porcelain-tide.webp`: cobalt-and-ivory porcelain wave curling around a miniature lighthouse,
  with fine crackle and sparing gold repair seams; no text, logos, or watermark.
- `case-tangerine-camera.webp`: unbranded tangerine instant camera on a translucent lavender plinth;
  no labels, letters, logos, extra products, or watermark.
- `case-velvet-fox.webp`: natural red fox seated on a sculptural violet velvet chair in a deep-plum
  studio; no clothing, accessories, people, text, logos, or watermark.
- `case-origami-koi.webp`: exactly two translucent folded-paper koi in a quiet dark-teal underwater
  garden; no people, text, logos, frame, or watermark.
- `case-desert-pool.webp`: mid-century desert home and turquoise pool at dusty-rose sunrise; no people,
  signage, text, logos, or watermark.

<details>
<summary>Final built-in image generation prompt set</summary>

### `case-mediterranean-room.webp`

```text
Use case: photorealistic-natural
Asset type: EzPic landing-page inspiration gallery card
Primary request: a sunlit Mediterranean living room after a tasteful AI restyle
Scene/backdrop: airy apartment with limewashed plaster walls, warm oak furniture, soft linen upholstery, one olive tree, handmade ceramic accents
Style/medium: high-end editorial interior photography, realistic and naturally lived-in
Composition/framing: wide 4:3 room view at eye level, strong architectural lines, layered foreground and background
Lighting/mood: soft late-morning sunlight, calm, tactile, inviting
Color palette: warm bone, terracotta, olive, honey oak
Materials/textures: limewash, linen, aged wood, handmade clay, subtle real imperfections
Constraints: original scene only; no people; no text; no logos; no watermark; no split-screen; no UI
```

### `case-cobalt-product.webp`

```text
Use case: product-mockup
Asset type: EzPic landing-page inspiration gallery card
Primary request: a luxury cobalt-blue glass perfume bottle in a sculptural studio setting
Scene/backdrop: curved sand-colored plaster pedestal with a shallow reflective water surface and one soft translucent shadow
Subject: one unbranded cobalt glass perfume bottle with a minimal blank metal cap
Style/medium: premium editorial product photography, photorealistic
Composition/framing: portrait-oriented close product shot, slightly low angle, generous breathing room
Lighting/mood: crisp directional sunlight softened by a large studio diffuser, refined and modern
Color palette: cobalt blue, warm sand, silver, pale sky
Materials/textures: glossy glass, brushed metal, textured plaster, rippled water
Constraints: original unbranded product; blank bottle with no label; no text; no logos; no watermark; no extra products
```

### `case-emerald-fashion.webp`

```text
Use case: photorealistic-natural
Asset type: EzPic landing-page inspiration gallery card
Primary request: an editorial street portrait featuring a sculptural emerald-green jacket
Scene/backdrop: quiet modern city corner after light rain, softly blurred architecture
Subject: a stylish adult model wearing a bold emerald jacket over simple neutral clothing
Style/medium: photorealistic contemporary fashion editorial, authentic skin and fabric texture
Composition/framing: portrait crop from waist up, confident natural pose, clean silhouette
Lighting/mood: overcast daylight with luminous reflections from wet pavement, sophisticated and cinematic
Color palette: emerald green, charcoal, stone gray, warm skin tones
Materials/textures: textured technical fabric, wet asphalt, real skin, subtle film grain
Constraints: one adult subject; natural anatomy; no text; no logos; no watermark; no visible brand marks
```

### `case-blue-hour.webp`

```text
Use case: photorealistic-natural
Asset type: EzPic landing-page inspiration gallery card
Primary request: a quiet coastal motel transformed by cinematic blue-hour lighting
Scene/backdrop: mid-century roadside motel beside the ocean, empty foreground, distant horizon
Subject: the architecture and one vintage convertible parked under the canopy
Style/medium: photorealistic cinematic architectural photography with subtle film grain
Composition/framing: wide landscape view, low eye-level perspective, strong horizontal geometry
Lighting/mood: deep cobalt dusk with warm amber window glow, atmospheric but believable
Color palette: midnight blue, amber, faded coral, concrete gray
Materials/textures: painted stucco, chrome, glass reflections, slightly weathered surfaces
Constraints: no people; no readable signage; no text; no logos; no watermark; original scene only
```

### `case-citrus-editorial.webp`

```text
Use case: photorealistic-natural
Asset type: EzPic landing-page inspiration gallery card
Primary request: a simple citrus tart transformed into a vibrant editorial food photograph
Scene/backdrop: hand-glazed lavender ceramic plate on a dark plum table with a folded coral linen napkin
Subject: one elegant citrus tart with glossy fruit, delicate cream, and a few natural crumbs
Style/medium: premium magazine food photography, photorealistic
Composition/framing: close three-quarter overhead crop, portrait-friendly composition, crisp focal detail
Lighting/mood: sculpted window light with soft shadows, playful yet refined
Color palette: lemon yellow, lavender, coral, deep plum
Materials/textures: glossy citrus, flaky pastry, glazed ceramic, woven linen
Constraints: no hands; no utensils with logos; no text; no watermark; no extra dishes
```

### `case-paper-train.webp`

```text
Use case: stylized-concept
Asset type: EzPic landing-page inspiration gallery card
Primary request: a mountain railway scene transformed into layered paper-cut illustration
Scene/backdrop: alpine valley with a winding red train, pine forest, distant snow peaks, and small clouds
Subject: the train curving through the landscape as the clear focal point
Style/medium: handcrafted layered paper-cut art, tactile paper fibers, precise dimensional shadows
Composition/framing: square-to-portrait poster composition with sweeping S-curve through the scene
Lighting/mood: cheerful clear morning, tactile and imaginative
Color palette: cobalt sky, tomato red, alpine green, cream, pale lilac shadows
Materials/textures: cut colored paper, subtle fibers, stacked layers, soft cast shadows
Constraints: original illustration; no people; no text; no logos; no watermark; no frame or border
```

### `case-lunar-greenhouse.webp`

```text
Use case: stylized-concept
Asset type: EzPic landing-page inspiration gallery card
Primary request: a moonlit glass greenhouse transformed into an otherworldly botanical sanctuary
Scene/backdrop: a Victorian-style glasshouse at night, layered tropical foliage, faint mist, a glimpse of a deep indigo sky
Subject: oversized translucent leaves and delicate bioluminescent flowers as the focal point; no people
Style/medium: cinematic botanical editorial photography with believable materials and subtle surrealism
Composition/framing: portrait 4:5 composition, inviting central path, rich foreground-to-background depth
Lighting/mood: cool moonlight through glass with restrained violet and cyan plant glow, quiet and transportive
Color palette: ink blue, deep teal, electric violet, small coral highlights
Materials/textures: misted glass, glossy leaves, damp stone, subtle natural imperfections
Constraints: original scene only; no text; no logos; no watermark; no frame; no UI; polished enough for a premium AI image editor gallery
Avoid: fantasy characters, neon signage, excessive bloom, oversaturation
```

### `case-porcelain-tide.webp`

```text
Use case: stylized-concept
Asset type: EzPic landing-page inspiration gallery card
Primary request: a dramatic ocean wave and tiny coastal cliffs transformed into a handcrafted blue-and-white porcelain diorama
Scene/backdrop: an ivory studio backdrop blending seamlessly into the porcelain sea
Subject: one curling wave with foam sculpted from porcelain, miniature cliffs and a tiny lighthouse with no markings
Style/medium: museum-quality ceramic sculpture photography, tactile and highly detailed
Composition/framing: portrait 4:5 poster composition, wave curling diagonally through the frame, clean silhouette
Lighting/mood: soft gallery skylight, serene but powerful
Color palette: warm ivory, cobalt glaze, pale celadon, subtle gold repair lines used sparingly
Materials/textures: glossy glaze, fine crackle, hand-painted cobalt brushwork, matte unglazed edges
Constraints: original artwork; no text; no logos; no watermark; no border; no human figures; premium editorial finish
Avoid: real water, plastic appearance, busy background, branded lighthouse
```

### `case-tangerine-camera.webp`

```text
Use case: product-mockup
Asset type: EzPic landing-page inspiration gallery card
Primary request: an unbranded retro instant camera redesigned as a playful premium tangerine-orange product
Scene/backdrop: minimal lavender studio with a translucent acrylic plinth and one crisp geometric shadow
Subject: a single compact instant camera with blank surfaces, tangerine body, brushed aluminum controls, dark glass lens
Style/medium: photorealistic luxury product photography
Composition/framing: square 1:1 close product shot, three-quarter angle, generous breathing room, clear silhouette
Lighting/mood: bright directional studio light, playful and precise
Color palette: tangerine, soft lavender, graphite, brushed silver
Materials/textures: satin polymer, anodized metal, optical glass, frosted acrylic
Constraints: original unbranded product; no labels; no letters; no numbers; no text; no logos; no watermark; no extra products
Avoid: hands, straps, floating parts, distorted controls
```

### `case-velvet-fox.webp`

```text
Use case: photorealistic-natural
Asset type: EzPic landing-page inspiration gallery card
Primary request: a dignified red fox photographed as an editorial studio portrait
Scene/backdrop: a minimal deep-plum studio with a sculptural violet velvet chair
Subject: one healthy adult red fox sitting naturally on the chair, alert gaze, full ears and front paws visible
Style/medium: photorealistic animal editorial portrait, authentic fur and anatomy, refined magazine lighting
Composition/framing: portrait 4:5 crop, eye-level, centered but relaxed pose, clean silhouette
Lighting/mood: soft directional key light with warm rim light, intimate and quietly luxurious
Color palette: russet fur, deep plum, violet velvet, warm apricot highlights
Materials/textures: realistic layered fur, crushed velvet, matte seamless backdrop
Constraints: natural animal anatomy; no clothing; no accessories; no text; no logos; no watermark; no human
Avoid: anthropomorphic pose, cartoon styling, extra limbs, taxidermy look
```

### `case-origami-koi.webp`

```text
Use case: stylized-concept
Asset type: EzPic landing-page inspiration gallery card
Primary request: two koi fish transformed into folded translucent handmade-paper sculptures gliding through a dark teal underwater garden
Scene/backdrop: quiet underwater space with sparse ribbon-like aquatic plants and a few tiny air bubbles
Subject: one coral-orange koi and one pale lilac koi, clearly shaped from folded paper with elegant flowing fins
Style/medium: tactile paper sculpture photographed underwater, refined surreal editorial art
Composition/framing: wide 3:2 composition, graceful opposing curves with open negative space and strong depth
Lighting/mood: soft shafts of light from above, calm, weightless, dreamlike
Color palette: deep teal, coral orange, pale lilac, cream
Materials/textures: translucent mulberry paper fibers, crisp folds, softly feathered edges, subtle caustic light
Constraints: original artwork; exactly two fish; no text; no logos; no watermark; no frame; no people
Avoid: cartoon eyes, plastic, crowded coral reef, realistic fish skin
```

### `case-desert-pool.webp`

```text
Use case: photorealistic-natural
Asset type: EzPic landing-page inspiration gallery card
Primary request: a quiet mid-century desert pool transformed by luminous sunrise color
Scene/backdrop: low modernist home, long turquoise pool, sparse boulders and desert plants, distant warm mountains
Subject: architecture, water reflections, and one sculptural lounge chair; no people
Style/medium: photorealistic architectural editorial photography with subtle analog film character
Composition/framing: wide 3:2 landscape, low eye-level perspective, strong horizontal geometry, layered reflections
Lighting/mood: first light before the heat, dusty rose sky, long soft shadows, calm and cinematic
Color palette: turquoise, dusty rose, sand, apricot, charcoal
Materials/textures: rippled water, terrazzo, weathered stone, brushed metal, natural desert grit
Constraints: original scene; no readable signage; no text; no logos; no watermark; no extra furniture
Avoid: tropical vegetation, crowded resort, oversaturated HDR, night scene
```

</details>

## Brand icon refresh (2026-09-05)

The EzPic app icon was generated with the built-in image-generation tool as an original
transparent mark, then deterministically flattened to the product violet and apricot colors, cleaned
of stray dark guide pixels, padded, and encoded as the 512×512 `apps/saas/app/icon.png`. The shared
inline logo uses a simplified vector companion derived from the same crop-frame concept so it remains
crisp inside navigation and authenticated product chrome.

```text
Use case: logo-brand
Asset type: EzPic website app icon and favicon
Primary request: create an original compact geometric symbol for an easy AI image editor: two interlocking crop-frame corners fold into an open picture portal, with one tiny four-point editing sparkle at the open upper-right corner
Style/medium: crisp vector-friendly flat logo mark, minimal, modern, strong silhouette
Composition/framing: centered square icon with generous transparent padding; readable at 16px; balanced negative space
Color palette: deep iris violet for the main mark and warm apricot for the single sparkle; optional off-white negative space only
Constraints: genuinely transparent background with preserved alpha; symbol only; no letters; no words; no text; no mockup; no container tile; no border around the canvas; no gradient; no shadow; no 3D; no watermark; original design
Avoid: camera glyph, generic mountain-and-sun picture icon, magic wand, overly thin lines, tiny decorative details
```
