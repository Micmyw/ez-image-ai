# Image to image AI page

`/image-to-image` is the same-origin landing page for reference-based image generation.
Its English H1 is `Image to Image AI Generator`; its title is
`Image to Image AI Generator | EzImageAI`. The page uses EzImageAI in its header,
footer and breadcrumb.

The page covers the image-to-image keyword family in one URL. It does not create
separate generator, free, style-transfer, or from-image variants. The homepage retains
`ai image editor no restrictions` as its primary query.

Visitors use `LandingGenerator`; registered accounts use the existing
`RegisteredEditor` inside the usual account boundaries. This entry supports prompt-only
creation; adding a reference selects image editing in the existing workspace.
Uploads, availability, credits, guest admission, moderation, and private results use
the existing implementation. This route does not introduce a new generation API.

The route uses a quieter editor presentation: the registered form shows one short
prompt placeholder and offers suggested instructions in a closed disclosure. On
phones the compact reference upload sits above a full-width prompt. Labeled model
and output selectors each occupy a full row above the generation action, keeping
model names readable on narrow screens. Credits, upload limits, errors and policy
details remain available. The FAQ uses simple divided rows with a return-to-editor
link instead of a decorative image card. Floating editor controls yield when the
FAQ and page ending enter view.

The page contains three prompt examples, steps, limitations, and FAQ. The prompts
are editable starting points, not verified output examples or quality guarantees.
The examples now appear immediately below the editor as selectable product-background,
portrait-lighting, and watercolor comparisons. All three original prompt sections
are server-rendered, including inactive panels. Arrow keys, Home, and End select a
case; a native range input or the Original/Compare/Edited example buttons reveal
each full image. Images use `object-fit: contain` and responsive, lazy-loaded WebP
variants so the comparison does not crop the artwork.

Selecting **Use this prompt** fills the existing guest or registered editor and
returns focus to it. It does not upload the sample, change the selected model, or
start a generation. The user can supply their own reference. The generated images
are illustrative assets, explicitly not verified EzImageAI outputs; their source
paths and image-generation prompts are in
`apps/saas/public/images/image-to-image/provenance.json`.

Metadata, canonical URLs, robots rules, schema, sitemap, and existing translation
strings are preserved. New translations describe only the example controls, assets,
and streamlined editor labels.

Free access is described with its eligibility, quota, watermark, and retention
conditions. No unconditional free or unrestricted-generation promise is made.

The bare URL serves English. Explicit German, Spanish, and French `?lang=` views
retain the English canonical and receive `noindex, follow` through the public proxy.
The page owns one H1 and emits WebPage and BreadcrumbList data. It is included in
the sitemap with its actual content date, and is reserved from organization slugs.

Local implementation and checks do not establish deployment, search indexing, or
keyword rankings.
