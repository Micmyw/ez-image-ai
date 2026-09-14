# Public image delivery

The homepage uses `LandingArtwork` with content-versioned WebP assets under
`/images/landing/variants/`. `pnpm --filter saas artwork:landing` regenerates the manifest and
derivatives from the three featured model covers and the `public/examples/case-*.webp` originals.
Model cards use their existing 4:3 crop; prompt examples retain their original composition.
The original images remain the source of truth and the downloadable model-page references.

The earphone card has a responsive image preload restricted to desktop viewports. Homepage
images remain lazy on mobile and declare their dimensions before loading. Static variant URLs
contain a content hash and receive one-year immutable caching through `public/_headers`.
This policy covers public artwork only; authenticated media uses its existing private access path.

`landing-example-assets.test.ts` checks derivative dimensions, hashes, source freshness and the
small-image byte budget. Verify the production homepage for a single model catalog request,
absence of Recharts and documentation CSS, and rendering at desktop and mobile widths.
Local build or browser evidence does not establish a deployed PageSpeed score.
