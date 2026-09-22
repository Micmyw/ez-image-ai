# Homepage performance

## September 22 report follow-up

The supplied [mobile report](https://pagespeed.web.dev/analysis/https-ezimageai-com/gpj6p9taem?form_factor=mobile)
scores **72** for performance. Its [desktop counterpart](https://pagespeed.web.dev/analysis/https-ezimageai-com/gpj6p9taem?form_factor=desktop)
scores **93**. Both score 100 for accessibility, best practices and SEO. Lighthouse 13.5.0
captured them on September 22 around 04:28 UTC.

| Lighthouse metric   | Mobile | Desktop |
| ------------------- | -----: | ------: |
| FCP                 |  1.8 s |   0.6 s |
| LCP                 |  4.2 s |   0.8 s |
| Total blocking time | 412 ms |  167 ms |
| Speed Index         |  4.4 s |   1.5 s |
| CLS                 |  0.014 |   0.001 |

The mobile LCP element remains the consent paragraph. Its observed timing is 2.331 seconds;
the table reports simulated Lighthouse metrics. Script evaluation accounts for 1.327 seconds
of the 2.3 seconds of main-thread work. The longest application initialization task is 328 ms;
GA4 has 138 ms and 109 ms tasks, and Clarity has a 90 ms task.

Changes tied to this report:

- **Application initialization and unused JavaScript:** load the existing Better Auth SDK when
  session, linked-account or passkey queries execute. Preserve the session query key, cookie-cache
  bypass and error handling. Put the organization provider behind a client dynamic boundary with
  SSR retained; a conditional server component reference previously included it in guest scripts.
- **Prompt draft validation:** load the existing draft persistence module when submitting a text
  prompt. Save the same prompt, product and SKU before navigating to sign-in; restore the editable
  state if loading or storage fails. The guest upload path is unchanged.
- **Visible label mismatch:** derive output-setting names from their rendered children, with a
  hidden action prefix. The report's experimental `label-content-name-mismatch` diagnostic failed
  despite its 100 accessibility score. It was reproduced live and passes in the updated local
  Lighthouse snapshot, with no failing elements.

The production HTML's directly referenced JavaScript falls from **429,121 to 404,149 gzip bytes**
(24,972 bytes, or 5.8%). Initial script references decrease from 39 to 38; neither the full
authentication SDK nor the prompt-persistence marker appears in those initial scripts. Session
queries still load the SDK afterward. The browser resource test counts that later request too:
40 scripts / 422,845 gzip bytes, plus three independently cacheable stylesheets / 28,885 gzip bytes.
HTML is 64,121 gzip bytes, within the existing 64 KiB budget. The baseline was 63,370 bytes;
concurrent payment-translation changes also affected the candidate build.

Verification: the deferred-SDK unit assertion and production initial-script assertion failed
before their fixes. Afterward, 60 focused unit tests and nine production Playwright scenarios
passed, including signed-in account controls, prompt-save failure and retry, sign-in handoff,
model/SKU selection, uploads and 320/390/1440px layouts. The production build includes TypeScript.
The local Lighthouse snapshot scores 100 for accessibility, best practices and SEO.

Local mobile timing does **not** establish an improvement. Under 412x823 / DPR 1.75, Slow 4G and
4x CPU emulation, the baseline FCP/LCP was 1.740 seconds with 297 ms of long-task blocking. Three
candidate observations were 2.280 / 1.932 / 1.716 seconds, with 881 / 642 / 720 ms of blocking.
Another task was compiling and testing a development server during the candidate measurements,
so these samples do not provide an isolated timing comparison. They are retained in the evidence;
the deterministic resource reduction and functional checks are the verified outcomes. Local
analytics IDs were unset and generation was disabled. Recheck the deployed version with PageSpeed.

Remaining diagnostics:

- GA4 dominates the unused-JavaScript estimate; framework code contributes too. Keep the existing
  staggered analytics scheduling and supported browser compatibility.
- Third-party cache lifetimes remain controlled by Clarity and Cloudflare. The longest reported
  request chain ends at Cloudflare RUM, and Lighthouse lists no useful preconnect candidates.
- Render-blocking CSS has an estimated 150 ms opportunity. Retain cacheable CSS rather than
  returning to the previously rejected global-inlining experiment.
- The 47 ms forced-reflow diagnostic is unattributed; it does not identify a source-level fix.
  Image sizing already passes, so no new image derivatives are needed for this report.

Evidence: `.wrangler/evidence/pagespeed-2026-09-22/`. These checks do not certify a new online score.

## September 16 report follow-up

The supplied [mobile report](https://pagespeed.web.dev/analysis/https-ezimageai-com/6exzd6cohp?form_factor=mobile)
scores 69 for performance, 100 for accessibility, 92 for best practices and 92 for SEO.
The matching [desktop report](https://pagespeed.web.dev/analysis/https-ezimageai-com/6exzd6cohp?form_factor=desktop)
scores 70, 100, 96 and 100. Both were captured on September 16 at approximately 14:24 UTC.

| Lighthouse metric   | Mobile | Desktop |
| ------------------- | -----: | ------: |
| FCP                 |  1.9 s |   0.5 s |
| LCP                 |  4.1 s |   0.8 s |
| Total blocking time | 430 ms |  530 ms |
| Speed Index         |  7.0 s |   3.1 s |
| CLS                 |  0.009 |   0.001 |

The mobile LCP element is the consent paragraph. The desktop trace identifies the middle model
card image. The trace breakdown is an observed measurement and must not be substituted for
Lighthouse's simulated LCP in the table above.

Changes tied to the report:

- **Main-thread work and forced layout:** use `content-visibility: auto` on lower homepage
  sections. Preserve their server HTML and estimate initial block sizes; the browser remembers
  actual sizes after rendering. The editor and model row remain fully rendered. Keep these rules
  in the existing studio stylesheet rather than adding another blocking stylesheet.
- **Analytics execution:** queue visits immediately, then start GA4 and Clarity in separate
  paint/idle windows. A blocked or stalled first vendor cannot stop the second, and an early
  exit attempts all pending tags. Collection scope and consent behavior remain unchanged.
- **Oversized example images:** add content-versioned 288px WebP variants. The three reported
  assets (paper train, glasshouse, porcelain tide) total 60,924 bytes at 288px instead of 96,952
  at 384px, a 37% reduction. Preserve the original aspect ratios and previous cached files.
- **CSP issue:** a live browser reproduced Zod's caught `new Function` capability probe.
  Configure its shared `jitless` setting in Next's client instrumentation before application
  schemas initialize. Retain the production policy that disallows `unsafe-eval`.
- **Accessible names:** include visible upload and output-setting text in their names; let
  showcase cards derive their names from their visible content instead of replacing it.

Items that do not justify unrelated code changes:

- Mobile `robots.txt` failed because the audit's fetch timed out. The desktop audit passed,
  and a fresh request returned the expected valid rules and both sitemap URLs.
- The cache-lifetime warning concerns Clarity and Cloudflare's external scripts. Their response
  headers are vendor-controlled. The Clarity collection timeouts are also external failures.
- Retain independently cacheable CSS and framework browser compatibility. Do not reintroduce
  global CSS inlining or remove Next/Cloudflare polyfills solely to suppress diagnostics.

Verification uses the same local production-server setup before and after the patch, with
anonymous capability checks disabled by the local environment and no live analytics vendor IDs.
Two regression assertions failed before the thumbnail/name changes; three analytics assertions
failed before the scheduling change. All 41 affected unit tests then passed. The production
build, including TypeScript, and 10 focused Playwright scenarios passed. Those scenarios cover
320/390/1440px editing, model selection, upload/replace/remove, the floating editor, example
prompts, the comparison slider, motion controls, documentation styling and the CSP regression.

| Local cold-load observation                     |  Before |   After |
| ----------------------------------------------- | ------: | ------: |
| Mobile FCP / LCP                                | 2.084 s | 1.276 s |
| Mobile long-task blocking time (sum above 50ms) |  448 ms |  152 ms |
| Desktop FCP                                     | 0.388 s | 0.344 s |
| Desktop LCP                                     | 0.596 s | 0.552 s |
| CSP violations                                  |       1 |       0 |

These are single controlled observations, not online PageSpeed scores or a statistical benchmark.
Mobile emulation uses a 412x823 viewport at DPR 1.75, 150ms network latency, 200 KiB/s download
and 4x CPU slowdown; desktop uses 1350x940, 40ms and 1.25 MiB/s. Local CLS was unchanged
(0.090 mobile and 0.021 desktop). The build still has 39 referenced script files and three
cacheable stylesheets; the patch does not claim to remove the framework's unused-JavaScript
diagnostic. HTML remains below 64 KiB gzip and the aggregate text payload below 520 KiB gzip.

Evidence: `.wrangler/evidence/pagespeed-2026-09-16/`. These measurements were collected locally
before publication. Deployment and a new online PageSpeed score are not certified by these checks.

## Previous investigation

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
