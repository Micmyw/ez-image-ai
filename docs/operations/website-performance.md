# Homepage performance

Local investigation and verification: September 15, 2026. Baseline commit:
`11f967c80c01ac14cee877b81caf9bbb84224e5c`.

## Supplied production report

The [mobile PageSpeed report](https://pagespeed.web.dev/analysis/https-ezimageai-com/c3fe75ka8k?form_factor=mobile)
reports performance 68 and simulated LCP 8.34 seconds. The matching desktop report scores 93
with LCP 0.82 seconds. The mobile LCP element is the server-rendered cookie notice paragraph.
Its observed timing in that report is 2.42 seconds; do not equate observed trace timings with
Lighthouse's simulated metric.

## Changes and tradeoffs

- Split the registered editor, account menus, and account navigation behind client-side dynamic
  imports with SSR retained. The authenticated 404 boundary previously brought account navigation
  into the public homepage's initial bundle even though it was not displayed.
- Queue automatic GA4 page views immediately, then schedule vendor scripts after load, a paint
  opportunity, and idle time. A two-second deadline bounds the wait. See
  [website analytics](./website-analytics.md) for collection behavior and early-exit limitations.
- Enable Next's experimental `inlineCss` option. Initial HTML includes its styles, avoiding extra
  blocking requests. CSS content remains the same and documentation CSS stays on `/docs`.
  This option applies globally: full-page revisits transfer the styles with HTML again rather
  than relying solely on independently cached stylesheets. Next also serializes them in the
  initial RSC payload. Recheck this tradeoff if styles or repeat-visit patterns change.

## Local production evidence

The production resource check combines initial script tags and actual network resources, so
its script totals also include the legacy `nomodule` reference. Browser transfer figures below
count only resources actually requested by Chromium, including response-header overhead.

| Measurement                                      | Baseline | Updated |
| ------------------------------------------------ | -------: | ------: |
| Referenced JavaScript files                      |       40 |      36 |
| Referenced JavaScript, gzip bytes                |  464,225 | 397,315 |
| Requested first-party JavaScript, transfer bytes |  436,663 | 368,544 |
| Blocking stylesheet requests                     |        3 |       0 |
| Stylesheet content, decoded bytes                |  155,774 | 155,774 |
| HTML response, transfer bytes                    |   57,065 | 108,480 |
| Cold mobile LCP, observed                        |  2.248 s | 1.380 s |
| Cold mobile CLS                                  |     0.01 |    0.01 |

Cold traces used fresh isolated Chromium contexts, a 412×823 mobile viewport at DPR 1.75,
Slow 4G emulation, and 4× CPU slowdown against the local Node production server. Each table
timing represents one trace, not a statistical benchmark. Generation was disabled and real
analytics vendors were not configured in this local environment. The intermediate JavaScript-only
change measured LCP 2.336 seconds; the clear first-paint improvement came from stylesheet inlining.

The extra HTML bytes are offset on a cold visit by fewer JavaScript bytes and stylesheet requests;
cached repeat visits have a different cost profile. These results do not establish a new deployed
PageSpeed score or Cloudflare Worker runtime certification.

Verification passed: 26 focused Vitest tests, seven production Playwright scenarios covering
mobile/desktop editing, model navigation, dynamically loaded account controls, public 404s, and
homepage/documentation styles; SaaS production build with TypeScript; affected lint/format checks.
The new analytics timing assertions and guest account-bundle assertions failed on the original
implementation before passing with the changes. Local evidence is under the ignored
`.wrangler/evidence/mobile-performance/` directory.
