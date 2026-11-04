# Christmas wallpaper

The public `/christmas-wallpaper` tool is listed under AI Tools. It reuses the signed-in editor and existing guest handoff. English content is canonical; untranslated language views stay noindex. Private job and recovery query states retain the public indexing exclusions.

The homepage links to the tool beside its main editor heading and through a dedicated evergreen feature card with three phone previews. Both entries are ordinary server-rendered links. The existing homepage keyword heading and editor remain in place; `/create` does not show the seasonal promotion. Navigation and footer also include the tool.

Six independent images were created with Codex's built-in image generator on 2026-11-04. `christmas-wallpaper-artwork.json` retains their exact prompts and provenance. Optimized WebP copies live in `apps/saas/public/images/christmas`. They are style illustrations, not output from the site's generation providers. No product-model generation or face-preservation acceptance is claimed.

Presets request a lower central subject with a quiet upper third for phone output, or a right-side subject and left-side icon space for desktop output. The existing form continues to own references, quotes, funding, policy, uploads and submission. Applying controls preserves reference identity; explicitly switching to scene mode removes the selected reference. Edited prompts require confirmation before replacement. Unsupported aspect ratios are rejected without changing the form.

Ready account and guest outputs offer Preview & crop. Account output access is requested through the existing owner-authorized asset endpoint. The crop dialog loads private bytes into an in-memory Blob, cancels on unmount and revokes the object URL. Crop controls do not submit jobs or mutate server media. PNG output contains only pixels from the source; screen controls stay in DOM overlays. Downloads never upscale; the exact cropped dimensions are displayed.

The page is a distinct wallpaper output workflow, not a parallel Photo Ideas/Effects catalog. Its URL remains stable after the holiday. Publication, deployment and live generation acceptance are separate from local implementation checks.

## Local verification — 2026-11-04

- Focused SaaS Vitest: 12 files, 206 tests passed, covering public routing/indexing, draft returns, preset composition, crop dimensions and existing guest/account editor behavior.
- SaaS type-check passed. Affected-file Oxlint, Oxfmt and `git diff --check` passed.
- Two public Playwright tests passed: homepage links and keyboard navigation; six presets; photo preservation; custom prompt confirmation; scene-mode reference removal; actual aspect-ratio changes; unsupported-ratio rejection; fallback/private-query noindex; and 1440/390/320px layouts. PNG downloads matched the reported pixel dimensions, and toggling screen overlays produced identical exported bytes.
- The result-preview comparison stability harness passed all 11 cases against loopback fixtures, including access revocation, owner switching, delayed references and stable output images. Its fixture now ignores component CSS imports; the actual crop CSS is covered by the Next.js browser checks.
- Screenshots and the preview regression report are retained under `output/christmas-wallpaper/`. No real product generation, Git publication or deployment was performed.
