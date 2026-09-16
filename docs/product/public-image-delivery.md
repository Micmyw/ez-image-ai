# Public image delivery

The homepage uses `LandingArtwork` with content-versioned WebP assets under
`/images/landing/variants/`. `pnpm --filter saas artwork:landing` regenerates the manifest and
derivatives from the three featured models' landscape prompt examples and the
`public/examples/case-*.webp` originals. All homepage model cards and prompt examples retain
their complete original composition without cropping or hover zoom.
The original images remain the source of truth and the downloadable model-page references.

The Nano Banana Pro card has a responsive image preload restricted to desktop viewports. Homepage
images remain lazy on mobile and declare their dimensions before loading. Static variant URLs
contain a content hash and receive one-year immutable caching through `public/_headers`.
This policy covers public artwork only; authenticated media uses its existing private access path.

Each of the 12 model detail pages has its own visual direction and exclusive cover and example
images. After the FAQ, three clickable model recommendations restore the original portrait-card
layout, with a family label, model name, short description and navigation. Desktop uses three
columns with aligned text rows; mobile uses three stacked cards with the portrait beside the copy.
Artwork keeps its full composition and natural proportions, including on hover.

Each model owns three recommendation portraits, and each referring page receives a different
portrait belonging to its linked destination. The 36 placements therefore use 36 distinct images
across all detail pages. These preserve all 24 previous gallery assets (including 11 earlier
originals) and add 12 built-in generations. There is no separate two-image gallery. Restored
artwork is curated by visual direction; the source manifest records any previous model assignment.
Nano Banana 2 also owns its line-art reference and matching color study.
The directory and homepage previews use the artwork belonging to the model they link to.
`docs/product/model-artwork.json` records the active assets, model ownership, creative categories,
dimensions, built-in image-generation prompts and source filenames. Regenerate model-page
variants with `pnpm --filter saas artwork:generate`; keep old originals and hashed variants so
cached pages continue loading their assets.

`landing-example-assets.test.ts` checks derivative dimensions, hashes, source freshness and the
small-image byte budget. Verify the production homepage for a single model catalog request,
absence of Recharts and documentation CSS, and rendering at desktop and mobile widths.
Local build or browser evidence does not establish a deployed PageSpeed score.
