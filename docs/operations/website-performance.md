# Customer-facing performance

## October 20 full customer-surface follow-up

The follow-up covers the public tools/model catalog and model pages, examples,
Blog/Photo Ideas and legal/content pages, Docs, authentication, account and
organization settings, support, subscriptions/credit packs/Image Pass, image
history/assets/edit sessions, ordinary video and the three template families.
The audit follows actual routes and shared dependencies, including paths outside
the main editor. It does not treat a mock API, local build or source inspection as
evidence of production latency or a real payment/provider outcome.

Implemented changes:

- The studio loads the selected panel and current locale in parallel. General,
  security, notifications, billing, history list, history detail and assets have
  independent code boundaries. Hover/focus warms static resources only; rejected
  imports can be retried, and closing or switching ignores late completions.
  Studio links do not prefetch a complete private page when their click opens a
  panel instead.
- `studio.json` and `feedback.json` are generated client projections. Their source
  remains `saas.json` and `shared.json`; regenerate using
  `pnpm --filter @repo/i18n generate:client-messages`, and check parity with
  `pnpm --filter @repo/i18n check:client-messages`. Each locale is requested
  independently. Normal server translation consumers retain their full contract.
- Image-to-image public content no longer waits for the session outside its
  Suspense boundary. Coloring examples retain responsive dimensions and source
  sets; only desktop receives preload hints. Docs removes an unused whole-icon
  plugin. Model-link intent uses the existing route loading boundary; public 404
  and advertising CSP navigation paths are unchanged.
- Authentication forms prepare the existing SDK on intent and show operation
  progress immediately. OAuth attribution still completes before authentication;
  passkey errors do not navigate as though authentication succeeded. Onboarding
  remains pending through its completion callback. Notification/preferences and
  invitation failures are visible and retryable instead of appearing empty or
  successful. Normal sign-in autofill remains available.
- Feedback code has visible loading, close/Escape cancellation and explicit retry.
  A late download cannot reopen a canceled dialog; an opened form keeps its state.
- Safety-checked independent account/payment reads run concurrently. Page-local
  hydration carries security and organization data during client navigation.
  Organization aliases come from the authorized response, and related role/member
  views invalidate together. Confirmed support writes seed their exact scoped
  detail cache; unknown submissions keep their original lock.
- Public pricing retains static plan/credit-pack HTML and loads credit-pack
  payment components only on selection. Visited payment components stay mounted.
  Pending credit-pack/Image Pass status checks use a 120-second fast window,
  then 30-second read-only polling. Read errors stop automatic polling; explicit
  refresh or foreground return can resume. This does not create another order,
  capture again, or reinterpret a pending payment as failed.
- Private edit thumbnails request their existing authorized URLs only near the
  viewport. Hidden generation modes and hidden pages pause eligible status reads.
  Resuming reads does not resubmit or cancel server work.
- History polling targets active IDs from **all** loaded pages with bounded
  concurrency. Completed pages, order and cursors stay intact. Owner keys isolate
  history caches. Manual list refreshes take precedence over earlier polling
  rounds. Template-family filtering happens before pagination, including the
  cursor's owner/family checks; history does not require current generation access.
- Video history reuses the same current database evidence for its `canPlay` hint.
  A page changes from one list read plus one Prisma read per READY item to one
  list read, with a separate narrow cursor check when present. This is the
  application-query count, not a claim of one physical SQL statement. Actual
  playback still rereads authorization; ownership, settlement, moderation,
  checksum/ETag, expiry and historical audio rules remain enforced.

Controlled local production builds, using the same browser resource checks:

| Surface                                              | Before JavaScript gzip bytes | After JavaScript gzip bytes | Reduction |
| ---------------------------------------------------- | ---------------------------: | --------------------------: | --------: |
| Additional code on opening image history from Create |                      220,660 |                      21,279 |     90.4% |
| Login initial requested scripts                      |                      408,118 |                     392,418 |      3.8% |
| Pricing initial requested scripts                    |                      340,784 |                     332,507 |      2.4% |

History changes from 18 added scripts to four. Its regression check now enforces
a **32 KiB** added-code budget and excludes checkout and passkey-registration
code. Keyboard intent warms static code without reading private history. Tests
hold and reject chunk requests to verify close, retry, switching panels and
editor-draft continuity. Login checks that WebAuthn code is absent before intent;
pricing still serves all four credit-pack cards and prices in its initial HTML.

The combined candidate's first-video added payload is **30,744 gzip bytes**,
compared with **150,228** in the observed deployed resource set (**79.5% less**).
The first batch alone measured 29,326 bytes; subsequent shared changes account
for the combined figure. This comparison concerns downloaded code, not a
controlled before/after production latency measurement.

The final homepage check measures **441,973 JavaScript + 60,501 HTML + 33,679 CSS
gzip bytes**, or **536,153 bytes total**. The existing **526 KiB** aggregate and
64 KiB document budgets pass. All eight stylesheets remain independently
cacheable, with zero duplicated inline styles and the account/chart/docs
exclusions intact. The substantial homepage payload remains a constraint; the
history and video reductions are not reductions in the whole homepage payload.
Docs also no longer includes the unused whole-icon-map plugin in its server
chunks; chunk redistribution prevents attributing a precise overall server-size
saving to the former 139,018-byte gzip chunk.

Local verification completed:

| Check                                                                         | Result                                                           |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Production Next build, including TypeScript                                   | Passed                                                           |
| SaaS and i18n type checks; generated-message parity                           | Passed                                                           |
| Account, authentication, payments, support and shared UI units                | 462 tests / 58 files passed                                      |
| Media, video, landing and public-content units                                | 752 tests / 81 files passed                                      |
| Focused feedback/history-race and notification/invitation follow-ups          | 32 tests / 4 files and 12 tests / 2 files passed; overlaps above |
| Database history query units                                                  | 31 tests / 1 file passed                                         |
| Jobs history/authorization units                                              | 58 tests / 4 files passed                                        |
| API payments/video/playback units                                             | 89 tests / 6 files passed                                        |
| New customer performance browser scenarios                                    | 8 passed against the production build                            |
| Broad public/guest production browser coverage, including affected-spec rerun | 185 passed, 8 skipped across 193 scenarios                       |
| Affected-file lint, formatting and diff whitespace                            | Passed                                                           |

The broad browser run initially passed 182 scenarios and failed three older
content assertions. Two hardcoded an obsolete three-article catalog; they now
exercise the actual category/search behavior and target-article identity. One
mistook the read-only image-pass offer RPC's POST transport for a payment mutation;
only that verified query was added to the guard's exact allowlist. No generation
or checkout write was permitted. The two affected specs then passed all 20
enabled scenarios without application changes. Five skipped scenarios concern
an already-expired advertising preview, and three require an explicitly enabled
local administrator/database fixture. The reported 185 is the combined outcome,
not a claim that the original broad command exited successfully.

Before/after evidence and validation logs are in the ignored
`output/playwright/customer-performance-2026-10-20/` directory. These are local
checks. Browser account flows use fixtures; the run has no local PostgreSQL
service, and unmocked read paths can log connection failures. It does not certify
real authenticated database flows, checkout, provider generation or live latency.
These measurements were collected before Git publication. Publication and its
automatic CI/deployment results need separate verification against the resulting
commit. The implementation changes no production configuration and performs no
real payment or paid generation.

## October 20 page opening and mode switching

The reported slow operations were opening a page and switching features/models.
A fresh Chrome visit to the deployed homepage on the local network observed
6.66 s TTFB, 26.06 s FCP and 4.98 s for its first Image-to-Video switch. Individual
initial JS/CSS requests took several seconds. These are single network observations,
not field percentiles or Lighthouse results, and do not isolate Worker, origin or
CDN time. The local changes below have not been deployed.

The first video visit downloaded four complete SaaS translation dictionaries,
including administration and support text. Extracting the unchanged `videoV1`
namespace into `translations/{en,de,es,fr}/video.json` cuts its added JavaScript
from **150,228 to 29,326 gzip bytes (80.5%)**. The former is the deployed resource
set; the latter is the local production build's browser-observed added chunks.
The test checks a 64 KiB budget. `getMessagesForLocale(locale, "saas")` still
includes video copy and English fallback, and `SaasMessages` keeps the same keys.
All four extracted files were compared against the original JSON; no messages
changed. Raw locale key/placeholder parity is checked before fallback.

Changes to the opening and interaction path:

- Text editing waits for the public model catalog; reference editing waits for
  the upload capability. Their independent responses cannot reset an ongoing
  upload/sign-in handoff. Both availability reads time out after 12 seconds,
  with the existing explicit retry. Generation mutations retain their existing
  acceptance and retry rules.
- Video code preloads on tab hover or keyboard focus. Loading and pending-session
  states retain working mode buttons and a localized status. Replacing the loading
  tab preserves keyboard focus; both visited workspaces remain mounted.
- Model/SKU translations are memoized in the signed-in image form, avoiding a
  complete rebuild on every prompt keystroke.
- Independent account messages, organizations and purchase reads start together
  after authentication. The account guard skips organization reads when neither
  organization admission nor subscription eligibility needs them.
- Full account settings and support text wait for the registered boundary;
  public menus retain their labels and lazy account panels restore settings.
  Below-fold Photo Idea images load lazily even when their card is featured.

Controlled browser checks hold either availability request or video chunks open
to verify that unrelated controls remain usable. The focus regression was observed
before the fix. These checks use local API fixtures and do not create paid media.
The final production build passes TypeScript, 293 focused unit tests and all
52 scenarios in `landing.spec.ts` and `unified-generator-public-routes.spec.ts`.
Affected lint/format checks and the i18n package type check pass.

The final homepage resource check measures 443,285 JavaScript + 60,714 HTML +
33,675 CSS gzip bytes, **537,674 bytes in total**. It stays within the existing
526 KiB budget, with zero duplicated inline styles and the account/chart/docs
exclusions intact. The homepage total remains substantial; the 80.5% reduction
above applies specifically to the added first-video payload.

Production build timings cannot establish a live speedup over the network sample.
The remaining live delivery latency needs a deployed before/after trace and
separate HTML/API/CDN timing; this change makes no Cloudflare cache-policy changes.

Evidence is under `output/playwright/performance-2026-10-20/`: `live-cold.json`,
`live-video-switch.json`, `live-video-gzip.json`, `build-final.log`, `unit-final.log`
and `browser-final.log`. The failed `live-video-chunks.json` fetch is not evidence.

## October 19 generation feature budget

The approved generation changes add the visible feedback gift entry, account
continuation and safe upload retry. The first combined production Next build
measured 539107 gzip bytes. Deferring private workspace/feedback messages and the
unchanged upload protocol reduced this to 536726 bytes on PR39 `17f5c0d`, observed
identically on both browser-test attempts. The authenticated 39 and guest 29 browser
scenarios passed; the aggregate-size assertion was the remaining browser failure.
This is transfer evidence, not an online PageSpeed or execution-time improvement.

| Measured production build                     | JavaScript gzip | HTML gzip | CSS gzip | Aggregate |
| --------------------------------------------- | --------------: | --------: | -------: | --------: |
| PR34 baseline                                 |          437111 |     61887 |    32639 |    531637 |
| First combined features                       |          442208 |     63428 |    33471 |    539107 |
| Private messages and upload protocol deferred |          441133 |     62122 |    33471 |    536726 |
| Financial combination PR36 `3141e90`          |          441843 |     62353 |    33574 |    537770 |

The non-DDL candidate increases the measured baseline by 5089 bytes (0.96%). The
existing 520 KiB cap had only 843 bytes of baseline headroom. Maintain a bounded
**526 KiB** aggregate cap (538624 bytes), a 6 KiB/1.15% budget increase for these
approved interfaces, with 1898 bytes of headroom against the measured candidate.
The financial combined build independently measured 537770 bytes on both attempts,
1044 bytes above the non-DDL candidate, leaving 854 bytes under the same cap. Its
authenticated 39 and guest 29 browser scenarios also passed. Independent
source/resource review found no evidenced, safely removable heavy initial
dependency after these deferrals. Final exact-head CI must still pass; this budget
change does not certify it.

The independent HTML 64 KiB limit, cacheable external CSS, zero duplicated inline
styles, CSP and account/chart/documentation exclusions remain. Add explicit guards
that the feedback form and its CSS are absent from the initial visit and both
guest-upload endpoints remain outside initial scripts. Do not substitute generic
SHA or XMLHttpRequest markers, which other legitimate shared features can use.
The budget revision does not bypass the separate strict-type, database, provider,
security, artifact or browser-functional checks. It changes no generation policy,
moderation, credits, pricing or production configuration.

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
