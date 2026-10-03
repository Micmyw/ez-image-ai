# Public editor layout

The homepage, tool pages, model pages and Effects workbenches reuse the guest
`LandingGenerator` and account `GenerationForm`. Their main forms opt into
`data-composer-design="compact"` and the scoped
`modules/media/components/editor/generation-composer.css` stylesheet. Existing
layout props and floating editor docks remain compatible with route containers.

`ComposerHeader` shows Image as the selected category and a disabled Video category
with a localized coming-soon badge. These controls never submit the enclosing form.
Video is a future module; adding a reference continues to select image editing within
Image. The private status stays at the right of the heading.

The reference tile sits beside the prompt in both text and image editing. Reference-required
tools keep their validation and editing instructions. Prompt ideas use a small popover;
selecting an idea fills and focuses the prompt. Upload limits, progress, retries,
removal and private source status remain available without a full-width upload row.

Portalled prompt-idea popovers carry `studio-theme` themselves so their buttons inherit
the dark background, hover and focus tokens even outside the editor's DOM container.

The bottom toolbar contains the model selector, one `ImageOutputSettings` trigger,
and the generation action with its current credit cost. Its popover groups aspect ratio,
resolution, quality and the selected model's supported controls. Fixed dimensions are
informational; selectable dimensions use legal catalog SKU combinations. No image-count
control or fixed count badge is shown. Every request still produces one image.

Controls wrap based on the form's available width, including narrow desktop tool columns.
The generate action spans its own row on compact layouts. Text labels remain available
to assistive technology; controls retain focus states and popover keyboard behavior.
Show the private status once, with the credit and content policy available below the toolbar.

Before private draft recovery completes, account catalog controls keep their stable
placeholder state on server and client. The layout does not change authorization, quoting,
credit reservation, uploads, job submission or guest preview settlement. A catalog cached
by a sibling must not replace streamed markup and reset a prompt.

Guest previews keep the private watermark and storage flow. After watermarking and
clean-source deletion succeed, finalization records their observed completion on
PostgreSQL's clock. Worker clock differences must not leave a finished preview
waiting for a transfer retry. Retention, transfer fencing and credit settlement
continue to apply; there is no schema migration.

Keep CSS scoped to the opted-in main forms: Next.js may retain route styles after navigation.
Check guest and account states, supported model settings, reference selection/removal and
320 px, 390 px, narrow tool panels and desktop widths.

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
