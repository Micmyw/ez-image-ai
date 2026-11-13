# Sheru Bhai paid Photo Idea

Implementation date: 2026-11-13. Local development only; publication/deployment are separate.

## Authorized design

The user selected a paid-only trend template, promoting the existing USD 2.99 Image Pass and offering other paid plans. The subsequent correction selected an interaction: prepare the picture first, then show the purchase choices after Generate. Pricing is not the hero headline. The user explicitly requested built-in image generation for artwork and planned prompts; no real EzPic provider generation was commissioned for the examples.

Reuse the Blog/Photo Ideas identity at `/blog/sheru-bhai-ai-photo`, the shared editor, immutable Image Pass contracts and existing premium authorization. This avoids a separate catalog, payment SKU, credit ledger or provider workflow. The page is public/indexable, with private job/resume states retaining their existing indexing boundary.

## User flow and payment

1. Pick Photo with Sheru or Become Sheru and add one portrait.
2. Review/edit the prepared prompt; no automatic generation on selection or upload.
3. Click Generate. Customers without eligible access see a modal: existing USD 2.99 / three-successful-image pack first, other paid plans second, and Keep editing.
4. Eligible Image Pass users select IMAGE_PASS funding; active paid subscribers may use their existing valid credits. Ordinary purchased credit packs alone do not satisfy premium subscription eligibility. Existing server quote/preflight and transactional admission remain authoritative.
5. Preserve the source photo and prompt through the existing guest claim, account draft and safe return flow. Checkout never automatically generates a paid image on return.

Both presets use `image-nano-banana-2`, `nano-banana-2-1k`, PNG, 4:5. Model/SKU changes and restored free-model drafts cannot switch this template to a free product. This restriction belongs to this template; existing general-purpose editor permissions are unchanged.

## Prompt plan

Homepage discovery now features both illustrations in one recommendation immediately
above the existing quick-start cards. It links directly to this page, with no prompt injection
into the general homepage editor and no payment popup on the recommendation itself.
The `sheru-bhai` / `quick-start` entry click is included in the existing administrator report.
The recommendation uses four-locale copy and retains the homepage THD experiment values.

The complete customer prompts are maintained once in `apps/saas/content/effects/sheru-bhai-ai-photo.ts`; displayed/applied/copied prompts use those same version-1 values.

| Preset         | Identity instruction                                                                                              | Composition                                                                                        | Main failure checks                                                               |
| -------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `with-sheru`   | Uploaded person remains fully human; preserve face, hair, skin and clothes; add a separate white lion businessman | Waist-up, two subjects with space between shoulders, hands outside frame, warm sandstone courtyard | Human/lion face blending, duplicate subjects, merged bodies, incorrect head scale |
| `become-sheru` | Replace only the head with a white lion head; retain uploaded outfit/build/pose; do not automatically add a suit  | Single standing subject at palace entrance, visible outfit, complete mane within vertical frame    | Remaining human face in muzzle, floating head, changed outfit, extra hands/paws   |

The default is `with-sheru`. The form explains that `become-sheru` replaces the face. Prompts request consistency without promising exact face preservation. No performance or success-rate claim is supported by this implementation.

## Artwork provenance and visual review

Both images were generated with the built-in image-generation tool during this task on 2026-11-13 and visually inspected. They depict fictional subjects. They are separately created style illustrations, not customer photos, real EzPic outputs or evidence of the selected product's fidelity.

- `with-sheru.webp`: a fictional adult South Asian woman in a teal jacket beside a white lion in an ivory suit, calm expressions and natural warm courtyard light. Inspection found two distinct subjects, no visible text or extra people. Hands are outside the frame.
- `become-sheru.webp`: one white lion-headed figure in a charcoal bomber jacket, at a warmly lit palace entrance. Inspection found one character, a coherent collar/mane join and pockets containing the hands.
- Both public files are 896 × 1120. Conversion only resized and WebP-compressed the generated PNG; no creative retouching was applied.
- Original built-in outputs remain under the task's Codex generated-images directory. Their basenames are `exec-4927de1b-9eeb-4568-9fee-335196445fbf.png` and `exec-94c6b063-550a-4dab-bf46-d613346be4ae.png` respectively.

Artwork prompt for the co-star image:

> Create a high-end photorealistic editorial style-preview image for the Sheru Bhai AI photo trend, portrait 4:5 composition. Exactly two subjects stand side by side in a quiet elegant Indian sandstone palace courtyard in warm late-afternoon light: on the left a fictional adult South Asian woman around age 27 with natural medium-brown skin, dark shoulder-length wavy hair, understated makeup, a rich teal tailored jacket over a plain ivory shirt; on the right a tall fictional anthropomorphic WHITE lion businessman with realistic white fur, a full cream-white mane, calm amber eyes, an anatomically proportional lion head joined naturally to human-like shoulders, an ivory tailored double-breasted suit and a single understated gold chain. Both look at the camera with relaxed confident expressions. The human is entirely human and her head is never a lion; exactly one human face and one lion head, two separate bodies. Waist-up framing, hands outside the crop, a little clear space between shoulders, no contact or overlapping limbs. Elegant magazine portrait, believable natural skin and detailed fur/fabric, 50mm camera, restrained depth of field, soft architectural bokeh, warm sandstone with deep teal and ivory accents. Keep both full heads and manes comfortably inside the crop. No writing, captions, logos, watermark, cars, weapons, extra people, sunglasses, crowns or graphics. This is an original fictional style illustration, not a photo of a real person, and not a UI mockup.

Artwork prompt for the transformation image:

> Create one photorealistic editorial style-preview portrait for an AI lion-head transformation template, vertical 4:5. Exactly one fictional anthropomorphic white lion-headed person, shown from just above knees to comfortably above the mane, standing in a quiet sophisticated sandstone palace entrance at twilight. The lion's head has natural white fur, a full cream-white mane, calm amber eyes and a closed mouth, proportional to the shoulders, naturally attached at the collar. A relaxed human-like body wears an everyday charcoal bomber jacket over a plain off-white T-shirt, dark tailored trousers; no white business suit. Hands comfortably in the jacket pockets, shoulders relaxed, confident natural standing pose, looking directly at the camera. Detailed jacket stitching and fabric, believable fur, professional 50mm fashion photograph, soft warm architectural light behind, cool blue ambient shadows, palette charcoal and warm sandstone with ivory mane. The image should clearly communicate 'your outfit, a lion head' and feel visually coherent with an upscale Sheru Bhai palace portrait. No other people or animals, no human face mixed with the muzzle, no text, logos, watermark, crowns, sunglasses, weapons, cars or excessive accessories. This is an original fictional style illustration, not a product before-and-after screenshot.

## Content and presentation contracts

`presentation: illustrations` is explicit. Its artwork has an editorial provenance record and owner authorization; public serialization removes internal evidence and rights records. This branch cannot contain `examples`, preset tests, example IDs or `lastTestedAt`. Verified product-example recipes still require their original exact prompt/model/parameter evidence.

The visual treatment retains the site's typography and dark shell. The photo carries the identity: warm sandstone and ivory, offset by teal clothing. Local surfaces use charcoal `#151721`, deep teal `#213c3b`, soft teal `#a7d8ce`, gold `#d9ba7c` and muted text `#b4bfc4`. A two-option image picker sits above the composer; the selected style occupies the adjacent result panel. Mobile stacks the composer and preview, with no hover-only control.

## Verification boundary

Local verification on 2026-11-13:

- 236 tests passed across 15 affected SaaS test files: Blog routing/indexing, content contracts and asset provenance, image sitemap, paid Generate decisions, existing pass/subscription access, insufficient balance, draft return paths, and anonymous/registered message projections.
- `pnpm --filter saas type-check` passed, including Next route types and Fumadocs generation.
- Playwright `tests/sheru.public-routes.spec.ts` passed at 1440, 390 and 320 pixels: both presets, preserved uploaded photo, loaded illustration, no horizontal overflow, Generate-triggered purchase dialog, no guest generation request, and Keep editing. Public catalog and guest capability are local fixtures; generation is disabled during the run.
- Visual inspection found and corrected a global style overriding dialog width and a narrow mobile prompt column. The payment dialog is capped at 448 pixels; mobile photo and prompt controls stack vertically. The primary button promotes the existing image pack and the secondary button opens subscriptions.
- Scoped Oxfmt/Oxlint and `git diff --check` passed. A separate read-only review of premium access, legacy-pass exclusion and login/checkout recovery found no blocking issue.
- HTML and image sitemaps include the canonical Blog page and its two public illustrations. The existing private query-state indexing rules remain intact.

Local evidence: `.cache/sheru-bhai/unit-final.log`, `typecheck.log`, `browser-final.log`, and `previews/` (desktop/mobile workbench and purchase dialog). Temporary browser processes are task-owned and stopped after checks. Concurrent homepage-model artwork changes in the working tree were preserved.

Built-in image generation is artwork production only. No real provider output, Stripe payment, live attribution, Git publication or deployment was tested or performed. Customer prompts are ready for use, but their selected-model fidelity is not established by the illustrations or local tests.

### Homepage recommendation follow-up

- 89 affected tests passed: 55 SaaS rendering/handoff/translation tests, 26 API schema/ingestion tests, and 8 report aggregation tests. The Sheru key is accepted and appears as a separate homepage-card row; these are local mocked events, not live analytics.
- SaaS type-check, four-locale key parity, scoped formatting/lint and diff checks passed.
- Three browser journeys passed at 1440/390/320px from the homepage recommendation through the template's photo preparation and purchase dialog. The 320px journey activates the link with the keyboard. No generation or purchase is submitted. The isolated development server needs a longer first-navigation timeout for route compilation; this run does not measure production navigation latency.
- Logs: `.cache/sheru-bhai/home-unit.log`, `home-api.log`, `home-report.log`, `home-typecheck.log`, and `home-browser.log`. Recommendation previews are in `.cache/sheru-bhai/previews/home-recommendation-desktop.png` and `home-recommendation-mobile.png`.
- Work remains local. No push or deployment; concurrent changes were preserved.
