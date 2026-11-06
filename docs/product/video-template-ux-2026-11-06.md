# Video template presentation correction — 2026-11-06

The source is the current local `ez-airapvideo` checkout at `75c06e3`. This work changes
discovery, explanatory copy and the creator presentation. It does not rewrite generation
prompts, source media, prices, callback orchestration or accepted request identities.

## Flying Car: one experience, original sequence choices

`ez-airapvideo/src/lib/video-templates.ts` defines four choices in one Flying Car experience.
`src/modules/ai-tasks/video-prompt.ts` maps them to four existing text files:

| Choice                  | Original prompt file           | Format    |
| ----------------------- | ------------------------------ | --------- |
| Curved Ramp · Featured  | `flyingcar-curved-ramp-v5.txt` | 15s, 16:9 |
| Curved Ramp             | `flyingcar-curved-ramp-v6.txt` | 15s, 16:9 |
| Jump Over Fleet · Side  | `flyingcar-fleet-side-v1.txt`  | 7s, 16:9  |
| Jump Over Fleet · Front | `flyingcar-fleet-front-v1.txt` | 7s, 16:9  |

The prior directory incorrectly promoted each internal choice into a separate card,
duplicating the shared ramp preview. The directory now has one Flying Car card and
`/video-templates/flying-car` opens the source default Featured choice. The selector inside
the creator reaches the original keyed routes. Those routes retain their execution keys,
owner-scoped drafts, private input handoffs and history. Public metadata points to the one
Flying Car entry. No historical task is remapped to a different prompt.

## Content evidence and page structure

Adapted from the source `messages/en.json`, current dedicated effect pages,
`src/blocks/effects/short-effect-copy.ts` and `docs/effects/effect-page-copy-template.md`.
The copied generation contracts remain the capability boundary; source marketing is not
treated as evidence of EzPic availability, price, provider completion, song rights or quality.

| Entry              | Main keyword / intent                    | Distinguishing content                                          |
| ------------------ | ---------------------------------------- | --------------------------------------------------------------- |
| Original Rap       | AI Rap Video Generator                   | Four stages, solo/duo/no-photo, optional lyrics                 |
| Bulin 47           | Bulin 47 AI                              | One photo, red-lit street freestyle, 15s vertical               |
| Spin Me Round      | Spin Me Round Dance AI / Chipmunks Dance | Solo/duo/trio, arm circles, full turn, two scenes               |
| 58th Floor         | 58th Floor AI                            | Teal stage, silver hanging mic, solo/duo/person-and-pet         |
| Green Booth        | Green Booth Freestyle AI                 | Two standing performers, one black stand mic, 10s landscape     |
| Kung Fu Cat        | Kung Fu Cat AI                           | Cat/dog photo, tissue chop, 9s vertical                         |
| Paws at You        | Paws at You AI                           | Paw-to-camera, meadow, petals, 6s vertical                      |
| Source Hotel Lobby | Hotel Lobby AI                           | Two portraits, left/right assignment, template-defined duration |
| Flying Car         | Flying Car AI                            | One subject image, original ramp/fleet sequences                |

These are content themes, not measured keyword volumes or ranking claims. A stale comparison
in the source's 58th Floor FAQ describes Green Booth with headphones and separate microphones;
the dedicated current Green Booth copy and template instead define one shared stand mic.
The updated copy follows the current dedicated contract.

Each page now has a keyword-led title and specific introduction, source example beside the
creator, effect explanation, photo advice, three actual creation steps, FAQs and related tools.
English, German, Spanish and French use the same facts. Existing noindex/publication boundaries
remain unchanged. Example labels never claim EzPic generated the displayed source videos.

## Interaction and layout

- Retain the site's existing font and dark purple theme: background `#19131f`, card/theme
  surface, accent `#b79cff`, quiet label `#c6b1ff`, primary button from `--primary`.
- A three-column desktop directory becomes two columns, then one on narrow phones. Cards
  use readable summaries and one source example instead of repeated technical variants.
- Desktop detail pairs a bounded, uncropped example on the left with the creator on the
  right. Mobile places the example first. No new images or generated scene art are introduced.
- The creator leads with the actual photo slots and their roles. Green Booth labels the left
  hype partner and right lead rapper. Fixed duration, resolution and framing are readouts,
  not one-option dropdowns. Flexible quality settings stay collapsed until requested.
- Signed-out visitors see the required slots and preset format, with explicit sign-in links.
  Signed-in visitors retain private uploads, draft restoration, quote invalidation, separate
  credit confirmation and unresolved-submission protection.
- Hover previews are muted and scoped to one active player. Leaving stops hover playback;
  a user click enables sound and manual controls. Touch and keyboard keep explicit controls.
  Reduced-motion preferences suppress hover autoplay; no video is fetched just on page load.
- Preview images have no Preview badge or source corner label. Clicking or tapping the
  picture enables sound and native controls; only the close icon overlays manual playback.
  Source attribution remains in the surrounding page copy.

## Verification boundary

Focused catalog/render/draft checks, SaaS type checking and the affected Playwright public
route suite exercise local behavior. Browser-only account responses are fixtures and cannot
submit paid jobs. No real generation, paid moderation, production writes or deployment are
part of this presentation revision. The local preview is restored for user inspection after
the isolated browser checks; temporary test processes are tracked separately.

Executed verification: 5 catalog tests and 22 render/draft/handoff tests passed; the final
14-case Playwright suite passed, including real playback advancement of the original public
sample, hover exit, single-player allocation, touch, keyboard, reduced motion, guest photo
roles, fixture-authenticated cast changes, private handoff and 320/390/768/1440px layouts.
SaaS type checking, focused lint/format and whitespace checks passed. Desktop and mobile
screenshots were inspected after the original poster loaded. Temporary browser/server
processes exited; the user-requested local preview and its isolated database remain running.
