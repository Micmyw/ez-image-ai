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
- Keep shared CSS in independently cacheable stylesheets, and documentation CSS on `/docs`.
  Next's global `inlineCss` experiment was removed after production checks showed much larger
  HTML and slower desktop visual completion. It duplicates styles inside HTML and the initial
  RSC payload; the localhost first-paint improvement did not justify that production tradeoff.

## Initial local inlining experiment (superseded)

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
cached repeat visits have a different cost profile. These results did not establish a deployed
PageSpeed score or Cloudflare Worker runtime certification. The CSS configuration in this
historical comparison is no longer the final configuration.

Verification passed: 26 focused Vitest tests, seven production Playwright scenarios covering
mobile/desktop editing, model navigation, dynamically loaded account controls, public 404s, and
homepage/documentation styles; SaaS production build with TypeScript; affected lint/format checks.
The new analytics timing assertions and guest account-bundle assertions failed on the original
implementation before passing with the changes. Local evidence is under the ignored
`.wrangler/evidence/mobile-performance/` directory.

## Follow-up production report and version check

The [September 15 mobile report](https://pagespeed.web.dev/analysis/https-ezimageai-com/8w90iysv51?form_factor=mobile)
and its desktop counterpart were captured at approximately 12:25 UTC. At investigation time,
remote `main` was `e0002b5f0dfd4d12b7e9587efc8865cb580d9c8e`; the performance patch
`724b69e4ee8c3ae91f9b373b1ba28132c3336222` existed only on `codex/mobile-performance`.
The live HTML and the new report still referenced three external stylesheets and the original
39 first-party scripts requested by Chromium. Neither contained the CSS inlining or account
bundle split described above.

| Lighthouse measurement | Earlier mobile | New mobile | Earlier desktop | New desktop |
| ---------------------- | -------------: | ---------: | --------------: | ----------: |
| Performance score      |             68 |         55 |              93 |          88 |
| Simulated LCP          |        8.344 s |    3.001 s |         0.821 s |     0.801 s |
| Total blocking time    |         197 ms |   4,472 ms |          196 ms |      280 ms |
| Speed Index            |        5.075 s |    8.702 s |         0.810 s |     1.251 s |
| CPU benchmark index    |          705.5 |        131 |             466 |       525.5 |

Both reports use Lighthouse 13.4.1 with the same per-device simulation settings. However, the
mobile host benchmark differs substantially. Script transfer across first- and third-party code
changed by only 88 bytes (664,562 to 664,650), and CSS and image content sizes did not change.
37 of the 39 first-party script URLs were identical; the changed application chunk grew by
782 decoded bytes, alongside a webpack chunk-map update. The lower scores alone therefore
do not establish that the local, unpublished optimization regressed production performance.
The new mobile report's dominant problem is main-thread blocking, not a worsening LCP.

## Production inlining check and correction

After deployment of `da4fd05f29103dd60daeb566cfaf677737516591`, two independent PageSpeed runs
reported mobile scores of 92 and 90, but desktop remained at 85. The reports are
[e5nmowtr93](https://pagespeed.web.dev/analysis/https-ezimageai-com/e5nmowtr93?form_factor=desktop)
and [0l4kjvvtnc](https://pagespeed.web.dev/analysis/https-ezimageai-com/0l4kjvvtnc?form_factor=desktop).
A third requested link reused the second run's fetch time and results, so it is not an
independent sample. CPU benchmark differences still limit score attribution.

The desktop HTML grew from 341,878 to 655,085 decoded bytes. Its request completed at 4.40 and
5.24 seconds in those runs, delaying resource discovery and observed first paint. Script transfer
fell by approximately 70 KiB, and desktop script evaluation also improved; the larger document
and worse Speed Index were the remaining concern. These observations motivated removing global
CSS inlining while retaining the independent script and analytics changes.

The production regression check now requires cacheable external CSS, a document below 64 KiB
gzip, and an aggregate 520 KiB gzip budget for HTML, referenced JavaScript, and external CSS.
Inline CSS is counted inside HTML only. The captured inlined production document failed the
document budget at 109,117 gzip bytes before the correction. These deterministic checks
complement browser timings; they are not PageSpeed scores or assurances about third-party
execution time. Recheck the final deployed version on both devices.

Final local production verification after removing inlining: 36 referenced first-party scripts,
397,316 JavaScript gzip bytes, 338,897 decoded HTML bytes / 55,595 HTML gzip bytes, and three
external stylesheets totaling 26,471 gzip bytes. The aggregate is 479,382 bytes (468 KiB),
below both budgets. Seven focused production-browser scenarios passed, including desktop/mobile
editing, account controls, model navigation, public 404s, and documentation styles. The production
build includes TypeScript validation. The unchanged analytics and dynamic UI tests had already
passed all 26 cases on the synchronized main baseline. These are local checks, not final online
PageSpeed measurements.
