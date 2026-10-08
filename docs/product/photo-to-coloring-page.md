# Photo to coloring page

Route: `/photo-to-coloring-page`. Added 2026-10-03.

The primary task is editing a photo uploaded from the user's device, without generating an image first. The shared guest and signed-in editors require a reference. Simple, balanced and detailed options and background removal/simplification prepare a public prompt. Applying options explicitly replaces that prompt and preserves the selected source; it never submits a generation. Recovered account drafts take precedence over the default tool prompt. Existing upload, model access, credits, moderation, private media and generation APIs stay authoritative.

Result previews on the homepage, editor and history, guest results, and image library cards expose a compact **Turn into coloring page** link. They do not expose paper-size or print settings. The link carries the selected output's opaque asset ID to the tool, not the original input, old prompt or signed URL. A fresh account source-only handoff starts with the coloring prompt; claimed drafts retain the user's instruction. Account ownership/readiness checks still apply.

Guest result links also carry the job ID. The tool obtains a fresh authorized read URL (using the registered grant when appropriate), reads the approved watermarked image into a bounded in-memory File, and seeds the existing upload form. It accepts JPG/PNG/WebP up to 10 MiB, limits streamed bytes, aborts on exit/timeout and releases object URLs. Expired or inaccessible results show retry and own-photo upload options. A new edit follows the normal upload, review and generation flow; navigating to the tool never uploads or generates. No signed URLs or image bytes are saved in navigation or browser storage.

A4/US Letter printing is enabled only in the coloring workbench, its opened-source controls and its illustrative example. Global history drawers keep the compact link even on this route. Printing retrieves an authorized image (or uses the image just opened by the guest importer), waits for it to load and opens the browser print dialog with one image, 12 mm margins and `object-fit: contain`. Users can save a PDF through that dialog. It is not a vector conversion or resolution upgrade. An unavailable image produces a retry/download message, and the temporary frame is removed after printing, failure or component cleanup.

## Public content and search

The English route owns `turn photo into coloring page`, with natural coverage of `photo to coloring page`, printable outlines, background simplification and printing. Homepage keywords and metadata are preserved. The route has one H1, canonical and social metadata, a sitemap entry with a recorded content date, public navigation links, server-rendered instructions, comparison guidance and FAQs. Explicit translated UI views keep the English canonical and `noindex, follow`. The top-level slug is reserved from organization URLs.

Structured data describes the visible WebPage, WebApplication and breadcrumbs. No invented reviews, ratings, free prices or rich-result promises. GEO work consists of accessible factual answers and clear product limitations. No special AI markup or `llms.txt` requirement is claimed.

Personal source/result query URLs use matching SSR and `X-Robots-Tag: noindex, nofollow` and retain the bare English canonical. The public FAQ explains how to open an existing result, the explicit generation step and guest expiry.

Official guidance checked via HTTP 200 on 2026-10-03:

- https://developers.google.com/search/docs/appearance/ai-features (visible update 2025-12-10)
- https://developers.google.com/search/docs/appearance/google-images (visible update 2026-03-02)

## Demo asset provenance

The built-in `image_gen` tool produced both illustrative assets. They are not evidence of a real EzImageAI generation and are labeled as illustrations on the page. No customer image is included.

- `apps/saas/public/images/coloring/dog-photo.webp`: original golden retriever photograph illustration, 800 × 1000.
- `apps/saas/public/images/coloring/dog-coloring-page.webp`: line-art edit of the same illustration, 800 × 1000.

Source prompt: “Create one original photorealistic reference photograph for a photo-to-coloring-page web tool. Portrait 4:5 composition. A friendly golden retriever sitting facing the camera on a garden lawn, wearing a simple solid teal bandana, with a small plain ball beside its front paw. Entire dog including paws and tail is visible, centered with generous empty margin. Soft daylight, natural golden fur, a few large broad-leaved plants and simple softly blurred background. Clear silhouette and recognizable face, no people, no text, no logos or watermark. This is the source photo, so full natural photographic color and texture; not a collage, not a drawing.”

Edit prompt: “Edit this source photo into a printable coloring page. Preserve the same seated golden retriever, facial expression, bandana, ball, full-body pose, tail and composition. Convert to clean confident black contour lines on pure white paper with closed shapes and generous open spaces to color. Medium-simple detail: only a few curved fur contours, no individual fur hairs. Remove the entire garden/background to plain white; retain the dog and ball with a minimal ground line. No gray, shading, hatching, textures, color, gradients or solid black filled regions except tiny eye pupils. No added objects, text, logos, borders, watermarks. Keep same portrait 4:5 crop and complete paws. This is an illustrative example, not a screenshot.”

Observed limits: the illustrative line drawing changes some facial and ball details. Actual model output must be reviewed and is not guaranteed to match these illustrations.

## Local verification (2026-10-03)

- Seven focused SaaS Vitest files passed: 65 tests covering the new page, source requirement, draft precedence, sitemap, public routing, homepage and shared editor behavior.
- Five Playwright public-route checks passed, including desktop/mobile widths of 1440, 390 and 320 pixels, canonical and localized noindex behavior, image preservation while changing instructions, and A4/Letter print-frame sizing and error cleanup.
- The upload handoff check used mocked capability and draft responses plus a temporary loopback upload receiver. The receiver verified the original photo's byte count and SHA-256; completion carried the same hash and selected coloring instruction. It did not call a generation provider or production storage.
- SaaS type-check, affected-file Oxlint and Oxfmt checks, `git diff --check`, and `next build --webpack` passed. The build retained existing Hono/Fumadocs dependency warnings and missing optional local OAuth credentials.

The local PostgreSQL service was unavailable. Unmocked catalog requests therefore showed the existing unavailable state; these checks do not certify authenticated end-to-end generation or a live provider result. Printing checks intercepted the browser print call and inspected its image-only document; no physical printer was used.
