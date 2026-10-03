# Public editor layout

The homepage retains the standard guest generator and signed-in `studio` composer.
`StudioShell` loads the shared `studio.css` baseline without page-specific composer overrides.
The dedicated workspace and Effects workbenches retain their own layouts.

`/image-to-image` owns its responsive composer styles in
`apps/saas/modules/landing/components/image-to-image.css`, imported by `ImageToImagePage`.
The signed-in composer uses `minimal` on this route. Below 768 px, the reference appears
above the full-width prompt, followed by labeled model and output selectors and the
generation action. Prompt instructions remain in a closed disclosure; selecting one
fills and focuses the prompt and closes the disclosure. Upload limits, status,
validation and credit information remain available.

Composer overrides are scoped to `[data-image-to-image-page]`. Shared composer class
selectors use `:where([data-image-to-image-page])` to preserve their original specificity.
Keep this selector boundary even when importing the stylesheet from the route component:
Next.js can retain stylesheets after client navigation. Effects composer overrides stay
inside `.effect-workbench-controls` in `modules/effects/effects.css`; they must not target
the homepage or `/image-to-image`.

The shared gallery's responsive and input behavior is described in
[Public example gallery](example-gallery.md). Its gallery stylesheet also owns
mobile dock suppression on the homepage and `/create`.

Floating editor bars stay hidden on phones on both `.studio-home` routes (`/` and
`/create`) and `/image-to-image`, so they cannot obscure artwork or its controls.
Desktop bars also hide while the `data-editor-dock-clear` gallery is visible,
unless the guest is already editing in its expanded dock, and stop before the
closing `data-editor-end` section.
Examples and the final return link continue to lead back to the editor.

Changes to these layouts must preserve the existing headings, translated SEO
copy, metadata and canonical routing. Check both guest and signed-in compositions
at 320 px and 390 px, plus a desktop width; checking only the image-to-image route
does not cover the homepage.
