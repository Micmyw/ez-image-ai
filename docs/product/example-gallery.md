# Public example gallery

`ShowcaseSection` and `showcase.css` provide the shared example gallery on `/`,
`/create`, and `/examples`. Keep gallery presentation self-contained so a direct
visit to any of these routes includes its styles.

Cards use two masonry columns on phones, three from 900 px, and four from 1280 px.
Keep each source image's natural aspect ratio so portrait, square, and landscape
images form a varied layout. Category tags sit on the artwork; captions do not
add a separate block below it.

Mouse hover gently lifts the card, zooms the image, and reveals a gradient prompt
overlay. Keyboard focus reveals the same prompt with a visible focus ring. Small
cards clamp the visual excerpt while the existing action passes the full prompt.
Touch cards always show a compact use-prompt action. Reduced-motion preferences
disable movement and transitions without preventing the prompt from appearing.

The gallery stylesheet hides floating editor bars below 768 px on `.studio-home`
routes (`/` and `/create`). On desktop, editor observers also hide the bar while
the `data-editor-dock-clear` gallery is visible, unless a guest is already editing
in its expanded dock, and stop before the closing `data-editor-end` section.

Changes must preserve existing headings, translated SEO copy, prompts, alt text,
metadata, and canonical routing. Check 320 px, 390 px, and a desktop width; verify
hover, keyboard focus, touch actions, reduced motion, and complete prompt handoff.
