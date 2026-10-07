# Plus Jakarta Sans

The site bundles the same Plus Jakarta Sans family used by its original Google
Fonts integration. `next/font/local` serves this font from the application and
lets production builds complete without contacting the Google Fonts CSS API.

- Source: [Google Fonts, pinned revision](https://github.com/google/fonts/tree/8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5/ofl/plusjakartasans).
- Upstream file: `PlusJakartaSans[wght].ttf`; stored here under a filesystem-friendly
  name with identical bytes. Only the existing normal 300–700 range is registered.
- Git blob: `0cb13a998ed525ba226d911b10d6c4c4f923a961`.
- SHA-256: `89b3fb38aa0d275d7a731d0d817a4f1622b316b4d7fbdecdf02ee9099ff68bc8`.
- Copyright: 2020 The Plus Jakarta Sans Project Authors.
- License: SIL Open Font License 1.1; the unmodified upstream license is in `OFL.txt`.

The prior production build failed in Next.js's Google font URL-extension parser
before page compilation completed. The local file removes that remote build
dependency without a new npm package or a font-family change.
