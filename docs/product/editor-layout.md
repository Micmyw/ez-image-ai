# Public generation composer

The homepage, image-to-image, photo-to-coloring-page and model pages reuse
`LandingGenerator` for guests and `GenerationForm` for accounts. Their main forms
opt into `data-composer-design="prompt-first"` and the scoped
`modules/media/components/editor/generation-composer.css` stylesheet. Existing
`default` and `minimal` layout props remain compatible with route containers.

Text generation places the full-width prompt first, followed by an optional
reference image and a closed prompt-ideas disclosure. Selecting or requiring a
reference moves the source before the editing instruction and uses editing ideas.
Choosing an idea fills and focuses the prompt and closes the disclosure. Upload
limits, private source status, removal, validation and credit policy stay available.

`ImageOutputSettings` uses `presentation="composer"` in the main forms. Ratio,
fixed one-image output and the first supported model dimension form the primary
row. Extra quality, format or background controls use a separate responsive row.
Fixed dimensions are informational; selectable dimensions use the catalog's legal
SKU combinations. The generation button displays the selected credit cost.
Floating editor docks keep their compact settings popover.

Before private draft recovery completes, the account form keeps catalog-dependent
controls in the same placeholder state on server and client and defers interaction.
A catalog cached by a sibling must not replace streamed markup and reset a prompt.

Guest previews keep the private watermark and storage flow. After watermarking and
clean-source deletion succeed, finalization records their observed completion on
PostgreSQL's clock. Worker clock differences must not leave a finished preview
waiting for a transfer retry. Retention, transfer fencing and credit settlement
continue to apply; there is no schema migration.

Controls stack based on the composer's width, including narrow desktop columns.
Styles remain scoped to opted-in main forms because Next.js can retain route CSS
after navigation. Preserve headings, translated SEO copy, metadata and canonicals.
Verify guest and account forms at 320 px, 390 px and desktop widths, covering text,
required-reference, fixed-output and configurable-model states.
