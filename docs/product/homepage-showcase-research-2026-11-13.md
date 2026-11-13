# Media.io AI homepage: observed dynamic showcase

Inspected the live `https://www.media.io/ai` in Chrome on November 13, 2026. This browser
redirected to `https://www.media.io/ai/zh/home`. Observations below describe that session,
not every locale, visitor bucket or an inferred conversion result.

- After loading the editor homepage, an approximately 450px-wide centered popup appeared
  over a dark backdrop. A large media panel dominated it, with a short title over the bottom
  edge, segmented carousel navigation, a full-width creation button and an X at top right.
- The popup was an actual video carousel. DOM inspection showed `video` elements with
  `playsinline`, `autoplay`, `loop` and posters. Playback was muted. Consecutive observations
  showed video time advancing, active slides changing and previous samples paused.
- Examples observed included No Scrubs, Seedream 5.5, Tiny Desk, AI Story and Kling. Some
  carousel slides were static images; they were not all motion examples.
- The carousel advanced automatically (roughly six seconds per observed video). Clicking
  a segment selected its slide and changed the title and CTA. A later CTA click navigated to
  the then-current Seedream creation route. This makes a stable target during decision time
  valuable; EzPic uses manual slide changes and loops the active complete sample.
- The homepage behind the popup also contained muted looping video cards. Their `currentTime`
  values advanced. These were not only CSS-animated posters.
- Clicking the popup CTA dismissed it and opened a feature-specific creation page with
  campaign query parameters. No generation was submitted during this inspection.

## Adaptation for EzPic

Keep the result-first media area, immediate muted motion, short feature copy and one direct
creation action. Use existing source-template samples in full, with optional sound and visible
playback controls. Match the current studio's lavender palette and Plus Jakarta Sans, with
a dark cinema area and light text panel. Avoid inventing new result evidence from illustrative
photo covers. Add three thumbnail selectors and arrow controls, a once-per-release invitation,
and a persistent homepage replay entry. Close/pause behavior and resource cleanup are part of
the implementation, as are narrow screens and reduced-motion playback.

The live competitor inspection establishes the interaction pattern. It does not establish
their conversion rate, their display-frequency policy, or EzPic production generation quality.
