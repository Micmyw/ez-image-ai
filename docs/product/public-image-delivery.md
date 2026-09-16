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

Each of the 12 model detail pages has its own visual direction and exclusive cover, example and
portrait-gallery images. The gallery appears before the FAQ with two complete portrait images:
two columns on desktop and one column on mobile. It preserves 11 earlier originals and adds 13
built-in generations. Restored artwork is curated by visual direction; the source manifest records
any previous model assignment. Across all detail pages, every active asset belongs to one model
and appears once on that page. Nano Banana 2 also owns its line-art reference and matching color study. Related-model
links use text only so visiting different model pages does not repeat other models' galleries.
The directory and homepage previews use the artwork belonging to the model they link to.
`docs/product/model-artwork.json` records the active assets, model ownership, creative categories,
dimensions, built-in image-generation prompts and source filenames. Regenerate model-page
variants with `pnpm --filter saas artwork:generate`; keep old originals and hashed variants so
cached pages continue loading their assets.

`landing-example-assets.test.ts` checks derivative dimensions, hashes, source freshness and the
small-image byte budget. Verify the production homepage for a single model catalog request,
absence of Recharts and documentation CSS, and rendering at desktop and mobile widths.
Local build or browser evidence does not establish a deployed PageSpeed score.
