# Homepage and image-to-image layout restoration

Verified locally on 2026-09-30, against the existing checkout baseline `aed472a`.

## Reported regression and correction

The homepage's registered editor had been switched from `default` to `minimal`, hiding its
mode heading, prompt guidance and always-visible instruction choices. A shared
`editor-composer.css` import also broadened image-to-image overrides to the guest homepage.

- Restore the homepage's registered `default` layout. `/image-to-image` keeps its existing
  `minimal` layout; an explicit Effects editor context still selects the Effects layout.
- Remove the shared composer override import and unused stylesheet. Restore the original
  image-to-image CSS declarations, scoping shared class selectors with
  `:where([data-image-to-image-page])` so the original selector weight is preserved.
- Keep Effects styles inside `.effect-workbench-controls`. Remove the unnecessary homepage
  selector marker. Keep the existing gallery and floating-dock behavior.
  Move the 15 previously global instruction/model-label/privacy helper rules into this Effects
  scope too, preserving the registered Effects form's original declarations and selector weight.
- Put homepage Effects recommendations after the original model, examples and workflow content.
  Put image-to-image recommendations after its original examples and guide. The original
  first content sections now follow each generator again.
- Preserve the shared editor's upload, recovery, preset, credit and generation checks,
  the three verified 1980s presets and public images, and the Blog/Docs work.

## Engineering verification

- The corrected homepage-layout regression assertion failed before the implementation fix:
  it expected `default` and observed `minimal`. The other 12 workspace assertions passed.
- Final focused run: **3 files, 35 tests passed**:
  `ImageEditorWorkspace.test.tsx`, `GenerationForm.test.tsx`, `LandingPage.hero.test.tsx`.
  Coverage includes route-specific layout selection, the actual form's default mode heading,
  prompt label and help, four visible instruction choices, and original homepage section order.
- Format checks passed for all 9 affected code/style/test files; Oxlint and scoped
  `git diff --check` passed. Fumadocs source was regenerated for Next after Vitest.
- Removing only the new scope prefixes and retained mobile-dock block makes the image-to-image
  stylesheet declarations equivalent to HEAD. No page-specific declaration values were redesigned.
- All four locales' original `home`, `imageToImage`, `studio` and `media` message trees match HEAD.

## Browser verification

The existing development preview at `http://127.0.0.1:3002` was used, with no catalog or
eligibility stubs. These screenshots show the **anonymous** editor, not a signed-in account.

- Desktop (1440 x 1000), 390 x 844 and 320 x 844: homepage and image-to-image render without
  horizontal overflow. Their original first content sections follow the editor.
- At desktop and 390 px, client navigation from image-to-image and from Effects back to the
  homepage preserves the directly loaded homepage's background, padding, radius and prompt height.
  Exact measurements are in
  [browser-layout-check.json](../../output/editor-layout-restoration/browser-layout-check.json).
- The Effects detail still displays its workbench and all three preset sections, without overflow.

Screenshots:

- [Homepage desktop](../../output/editor-layout-restoration/home-guest-desktop.png)
- [Image-to-image desktop](../../output/editor-layout-restoration/image-to-image-guest-desktop.png)
- [Homepage at 390 px](../../output/editor-layout-restoration/home-guest-390.png)
- [Image-to-image at 390 px](../../output/editor-layout-restoration/image-to-image-guest-390.png)
- [Homepage at 320 px](../../output/editor-layout-restoration/home-guest-320.png)
- [Image-to-image at 320 px](../../output/editor-layout-restoration/image-to-image-guest-320.png)
- [Effects detail](../../output/editor-layout-restoration/effects-desktop.png)

## Limits and publication

The shared local preview's model-catalog RPC still returns 500, so its unavailable-state
controls remain visible. Existing local test-session fixtures also return the anonymous homepage.
The registered form was checked through component tests, not a new authenticated browser session.
No new generation was submitted and no credits were consumed during this restoration.

This correction has not been committed, pushed or deployed. No new persistent server was started;
the existing shared preview was left running, and temporary browser viewport overrides were reset.
The prior real generation evidence is unchanged in
[1980s content validation](1980s-ai-photo-validation.md).
