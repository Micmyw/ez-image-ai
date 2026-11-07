# Video template workspace revision — 2026-11-07

The workspace now prioritizes the source example, photo slots and Create. This follows the
user's screenshot review and a read-only inspection of Media.io's Hotel Lobby effect creator,
whose main controls were two uploads and aspect ratio. No assets or generation contracts
were copied from Media.io.

## Layout and controls

- Desktop retains the example and creator side by side, using the existing EzPic fonts,
  purple accent and shared Base UI selector. Portrait workspaces have a tighter maximum
  width; landscape examples can use the wider column. Mobile places the example first.
- Detail preview bounds follow decoded poster dimensions and video metadata separately.
  Playback uses the video's aspect ratio and closing restores the poster's ratio. Both
  preserve the complete frame, with a viewport height limit. Directory card cropping is
  unchanged. Close suppresses immediate hover replay until the pointer leaves.
- Photo slots have a bounded height, independent of the column width. Scene thumbnails
  form one compact row. Photo advice and sample audio details are expandable. The full
  price remains on Create and the content-rights/adult-content reminder stays visible.
- Rap exposes one optional lyrics/ideas field. New UI no longer offers separate language,
  occasion or custom-stage inputs. Legacy nonempty occasion/stage draft values remain in
  a collapsed saved-customization section with an explicit reset; accepted/uncertain
  request payloads are never migrated or rewritten. The server retains its original
  locale and composition semantics; no promise of exact language/lyrics is introduced.
- The four existing tier keys display their actual names: Seedance 2 Mini, Seedance 2 Fast,
  Seedance 2 and Seedance 2.5, verified against the existing server mapping. These are
  presentation labels, not new models or public provider routes. Existing option constraints,
  cached price recalculation, authoritative quotes and changed-price confirmation remain.
  Flexible format controls start in a compact expandable summary showing the actual model,
  duration, resolution and framing. Fixed template facts remain visible without fake choices.
  The public guide explains automatic photo optimization in English, German, Spanish and French.

## Photo preparation

Only source-template customer uploads use the new helper. Inputs already within the
server-advertised byte limit remain byte-identical. Oversized JPG/PNG/WebP files up to
40 MiB are decoded locally and encoded with WebP (preserving transparency), scaling down
proportionally to a maximum 2560 px edge. A bounded quality/size sequence must produce
nonempty allowed image bytes within the actual server limit, otherwise upload does not start.
Decoded dimensions are checked before canvas allocation, which is bounded separately from
browser image decoding. Blob URLs and canvas resources are released after processing.

Preparation completes before `uploads.create`; its MIME, size and uploaded bytes all describe
the prepared file. Existing source materials, immutable upload identity, private storage,
moderation, quota accounting and upload-completion semantics remain unchanged. A failed
local replacement keeps the already selected photo. There are no new generation requests,
database migrations or provider calls in the UI verification.

## Verification boundary

Use the affected render/draft/preparation unit tests, SaaS type check, focused lint/format,
and `video-templates.public-routes.spec.ts`. Browser account/upload responses are local
fixtures; public samples are existing media. Local proxy DNS resolves source hosts to a
private test range, so original poster bytes are supplied through the suite's existing
fixture-manifest mechanism, without weakening production image URL validation.

This revision is local implementation and verification only; it does not claim deployment,
real upload/storage integration, moderation acceptance or generated-video quality.

Executed checks: 34 focused unit tests and all 16 public-route browser cases passed, along
with SaaS type checking and focused lint/format/whitespace checks. Browser cases include
real sample playback, distinct poster/video aspect ratios, closing without hover replay,
320/390/768/1440 px layouts, model/format constraints and a roughly 23 MB PNG compressed
to 2560 × 1920 WebP before a mocked upload. A corrupt replacement makes no new upload
request and preserves the previous photo. Screenshots and logs are retained locally under
`output/playwright/template-layout-2026-11-07/`.
