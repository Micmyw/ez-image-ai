# GPT Image 2.6 tools

The first version reuses the existing image composer, account gates, private
media history, authoritative quotes and generation recovery. Public model pages
are `/gpt-image-2-6-flare` and `/gpt-image-2-6-sunburst`, alongside
`/ai-svg-generator` and `/ai-gif-generator`. Legacy `/gpt-image-2-6` links redirect
to the selected model while carrying their continuation parameters. Availability
comes from the current model catalog; a public page is not proof that generation
has been enabled in a deployed environment.

## Product copy and limits

- Flare is the speed-focused option and uses medium quality in this version.
- Sunburst emphasizes detail and consistency across edits and uses high quality.
- Raster output offers 1K, 2K and 4K tiers. The provider's tier names are not a
  promise that every aspect ratio has a 4,096-pixel edge.
- Static SVG and GIF are exposed with the 1K selection. GIF frames are 512 × 512
  pixels, with 2–16 frames and 20–2,000 ms per frame in 10 ms increments.
- SVG uses static, self-contained vector shapes. Lettering must be outlined
  paths, not font-dependent text elements; scripts, external references,
  animation and embedded raster images are not accepted.
- The 64-frame Economy contract is separate and is not advertised by this
  version. Credit-funded generation follows the displayed quote.
- New purchases and remaining uses from existing USD 2.99 three-result packs
  cover Flare and Sunburst PNG/JPEG at 1K, 2K and 4K, static SVG and GIF. One
  successful result consumes one pass; a whole GIF consumes one pass regardless
  of its frame count. No subscription is required when explicitly paying with
  these passes. Account-credit eligibility remains separate.
- A versioned benefit policy extends eligible USD 2.99 grants without rewriting
  their original offer, order, payment or grant snapshots. Earlier USD 1 packs
  retain their original coverage and subscription policy.
- The separate model pages reuse ModelHero, DisplayTitle, GlowSurface,
  ModelExampleCard, ExamplePromptActions and the image-comparison component.
  Flare has four Kie examples and Sunburst has six Kie examples, with prompts,
  source request settings and file hashes in the November 14 material receipt.
  The additional Sunburst hummingbird GIF retains its EzImageAI production
  receipt. Internal evidence records sample origins and verification. Public
  copy focuses on capabilities, examples and prompt actions.

## SVG search intent

`/ai-svg-generator` owns the primary AI SVG generator intent. Its sections cover
text to SVG AI, AI vector illustration generation, website/app illustrations,
printable vector art and editing a generated SVG. These are semantic candidate
queries, not measured search volume or difficulty findings.

Keep these intents together while they share the same tool and user workflow.
Use the visible examples and FAQs to answer practical questions about clean
shapes, a limited palette, file structure, small-size legibility and print
preflight. Do not create thin synonym pages. PNG-to-SVG conversion, SVG logo and
SVG icon landing pages are outside the approved scope.

After real usage, use Search Console queries and user completion behavior to
decide whether a distinct, useful tutorial is warranted. Any future article
needs original examples and must link back to the canonical generator. Do not
publish sample results without actual output and rights evidence.

## Verification boundaries

Public-route tests cover the mounted guest/account editor, one H1, clean
metadata, visible FAQ/schema agreement and sitemap discovery. Browser checks
cover desktop and narrow layouts, route format defaults and prompt entry with a
mocked public catalog. These do not prove paid Kie generation, private output
processing, deployment, crawling or search performance.

The GPT Image 2.6 production release at `dbbc801e` was subsequently built by the
Cloudflare Linux builder and passed its final website Worker artifact smoke on
2026-11-11. Both model switches were enabled in production. These release facts
do not establish a paid end-to-end generation or deployment of the later image
pack benefit extension; see the separate release evidence in the
[rollout document](../operations/gpt-image-2-6-rollout.md).
