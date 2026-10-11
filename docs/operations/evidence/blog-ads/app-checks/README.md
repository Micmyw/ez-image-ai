# Local application, CSP and static sandbox verification

## Latest main including Vidu, 11 October 2026

The latest actual Next round passed **21/21**, with zero skips, failures or flaky results, at 12:40–12:42 UTC. It includes main `630e96492504211c19ff02a929c7dcffd87e079d`, source HEAD `2401424ee104e9b9be50e410d19b4675728d09f7`, the repaired client readiness control and the new finite preview deadline of **14:00 UTC**. `/blog/vidu-q4-preview` was added to the exclusion cases: it retains the original response CSP and creates no advertisement context. Only the same three reviewed ordinary article paths allow the advertising origin. Master switches remained false and supplier requests remained intercepted.

`ad-origin-post-vidu-summary-2026-10-11.json` records the exact command, source hashes and 21 outcomes; `ad-origin-post-vidu-app-evidence-2026-10-11.json` contains 17 actual application observations and two separately labeled sandbox canaries. `tesco-news-post-vidu-2026-10-11.png` is the fresh real article screenshot. Full reports remain in `output/playwright/blog-ads/ad-origin-post-vidu-20261011/`. The earlier **20/20** round below is preserved unchanged as history. Neither round ran supplier scripts or certifies live inventory, authenticated account behavior or checkout execution. Loopback public catalog reads still returned P1001/500 without a running database; this does not invalidate the isolation assertions or establish catalog availability.

## Native response guard and observer integration

`native-response-guard-summary-2026-10-11.json` records **8/8 cases and 114/114 assertions** on the final matching helper source. These are real self-authored loopback HTTP responses in fresh, sandboxed Chromium BrowserServers. The single root debugger session recursively pauses child targets, acknowledges their Fetch Response guard before resuming execution, intercepts the first child and nested 200/302 responses, and destroys the owned server on refusal. Redirect destinations had zero HTTP and Network request hits. Unknown decisions, bounded timeout and a late policy overlapping shutdown fail closed; an unguarded parent 307 control still succeeds. The earlier late per-frame implementation really followed a first OOPIF 302 to a self-owned destination (hit1); `ad-origin-response-guard-diagnostic-2026-10-11.json` preserves that failure. Dedicated duplicate-session and destructor-failure injection remain outside the dynamic test scope.

`observer-offline-integrated-summary-2026-10-11.json` records the final two-format execution at 12:57:02–12:57:26 UTC. Both statuses are **offline-fixture-only**. Context networking was disabled (`offline: true`), all 15 requests were fulfilled in memory, each exact placeholder loader was permitted once, and there were zero route continuations, safety stops, guard failures, page errors or popups. Both independently owned BrowserServer processes exited. Native 390→320→1280 checks retained the same Element, Frame, document timeOrigin and request count without horizontal overflow; Hide, article exit and history left zero advertising contexts. Source SHA-256 values were captured at startup and independently matched the final files. The full report is `output/playwright/blog-ads/observer-offline-final-hashed-20261011/observation.json`.

The memory fixture establishes observer integration and cleanup only. It does not certify Next source, real inventory, actual creative behavior or native HTTP first-response interception. Protected routes explicitly select the `/login` fixture and record the outcome as simulated; the live observer retains its actual protected-path navigation and login assertions. Earlier fixture failures are preserved: closing the context before marking the guard closing correctly tripped its unexpected-parent-detach protection; a mocked HTTP 307 bypassed the next route handler and attempted the empty loopback login address. Consequently zero `route.continue` alone was not physical network isolation. Final fixture contexts disable browser networking as a backstop and avoid mocked HTTP redirects. No real supplier or production observation has run, and these results do not activate advertising.

## Finite article-origin fixture verification, 11 October 2026

The newer independent-origin work passed **20/20** local browser cases at 12:04–12:06 UTC, followed by SaaS type-check. The master switches were false; only the finite Tesco preview exposed Show controls. Actual Next response headers allowed the fixed advertising origin on the three reviewed ordinary articles, while both child documents were fulfilled with self-authored empty HTML and all other external requests were intercepted. This proves application policy, consent/opt-in, credentialless transport, document navigation/history, expiry, synthetic sandbox isolation and empty-slot mobile bounds. It does not establish live inventory, actual native creative responsiveness, signed-in account behavior or checkout execution.

`ad-origin-offline-summary-2026-10-11.json` preserves the initial **19 pass / 1 fail**, the diagnostic lifecycle events, the successful unchanged targeted case and the final **20 pass / 0 fail**. The initial Show click occurred before client readiness and stayed Show through its next frame; the component now disables the SSR control until its layout setup and limits pageshow resetting to persisted restoration. `ad-origin-offline-app-evidence-2026-10-11.json` contains 16 actual application evidence cases and two separate harmless sandbox fixtures; `tesco-news-ad-origin-offline-2026-10-11.png` is the new real application article screenshot. Raw reports remain under `output/playwright/blog-ads/ad-origin-offline-final-20261011/`.

The following static-data transport reports are **historical checks of the earlier implementation**. Their whole-document CSP rejection does not describe the newer permitted independent-origin empty-fixture transport. Neither stage is usable-inventory evidence.

These checks ran in the isolated `ezimage-blog` worktree. The final full rounds ran after integration with main `41c0855726012efbd4054a7e1fac95c4ea5caed9`, at source HEAD `7b52cd543b653ebbfa3f1c89cb89683d086215f1`. They use an anonymous Playwright Chromium context with `chromiumSandbox: true` and a separate Next development server at `http://127.0.0.1:3018`. They do not use the user's Chrome tabs, authenticated storage snapshots, generation, checkout, payments, email sending or advertising clicks. The parent agent owns publication.

## Final latest-main result

The complete post-rebase default-off round passed **13 tests with 3 conditional skips**; the complete both-flags-enabled round passed **15 tests with 1 conditional skip**. Both have zero failures and zero flaky results. Article metadata, factual boundaries, official sources, sitemap and AI News noindex rules passed in both rounds. The earlier cold sitemap budget failure was resolved by retaining every assertion and allowing this multi-resource test 60 seconds; it passed on the integrated source.

`post-rebase-off-summary.json` and `post-rebase-on-summary.json` record each result and application counters. `post-rebase-app-ad-isolation.json` contains the exact owned-frame/CSP and route-clearance observations; `post-rebase-static-data-canaries.json` contains both rounds' harmless canaries. `post-rebase-source-version.json` records the integrated main, source HEAD and SHA-256 hashes for the spec, static document helper, component and article, with all four unchanged after both runs. The parent separately passed 67 focused unit tests, 9 Cloudflare guards, SaaS type-check and a 63-page production build on this integrated version before releasing source generation to the browser runs. These are local verification results, not deployment or usable-inventory evidence.

## Actual application result and first blocking layer

The unchanged application response policy allows `frame-src https://challenges.cloudflare.com`. It does not allow the static `data:` document used by `getBlogAdDocumentUrl`. After accepted existing consent and a fresh **Show blog ads** click, the owned iframe elements mount, but the parent `frame-src` rejects their entire documents. Their documents become `chrome-error://chromewebdata/`; the supplier scripts never run. **Hide blog ads**, SPA navigation, history, reload and hard navigation clear the contexts or restore a fresh display opt-in.

The prior `srcdoc` diagnostic fixtures exercised a different chain: an inherited parent `script-src` could reject supplier scripts inside a `srcdoc` document. Those fixtures do not describe the first blocking layer of the final static `data:` transport. A sandboxed `srcdoc` also inherited the host fallback `baseURI`, which was the reason for replacing that transport.

Chromium redacts data addresses to an empty `blockedURI` in DOM CSP events and an empty `blockedURL` in native CSP audit issues. The final positive assertion therefore combines a controlled fresh Show operation with all of the following:

- No iframe before Show and only the expected banner/native iframe elements afterward, with `sandbox="allow-scripts"`, `referrerpolicy="no-referrer"`, and `src` exactly equal to the static helper URL.
- New DOM `enforce` / `frame-src` violations whose `originalPolicy` equals the actual response header, together with new native `kURLViolation` / `frame-src` issues that are not report-only. Each count covers the expected formats.
- Native `Page.frameNavigated` error documents whose complete `unreachableUrl` is the exact static helper URL. `DOM.getFrameOwner` links each frame ID to an `IFRAME` with the corresponding `data-blog-ad-frame`; its `src` equals that same unreachable URL. Both expected formats must be identified. Unrelated formats and unrelated failed URLs are rejected by the predicate.
- The static data document never reaches the network safety interceptor. Request aborts cannot supply the native CSP or frame-owner evidence.

This proves rejection of the application-owned static documents under the original policy. It does not prove usable advertisements, supplier creative safety, real native layout, or advertising revenue. Provider request interception is a safety guard; opaque-frame network events and resource timings are not a complete network inventory. The publisher's public origin can remain visible through Chromium `ancestorOrigins`; the static transport does not interpolate private article paths, queries, account identifiers, prompts, images or signed resources.

## Stored evidence

- `default-off-summary.json`: complete default-off application run, **13 passed / 3 conditional skips**. This ran before the active transport changed; no application advertisement frames mounted. Its old standalone fixtures are explicitly excluded from the final transport privacy claim.
- `enabled-csp-blocked-summary.json`: final complete two-flags-enabled run, **15 passed / 1 conditional skip** for the default-off kill-switch test.
- `default-off-data-transport-summary.json`: historical targeted post-fix default-off, article SEO, AI News and static sandbox regression, **4 passed / 1 timed out**. The SEO test exhausted its 30-second overall budget during cold `/sitemap.xml` compilation. Its overall budget was then set to 60 seconds while retaining every fact and SEO assertion. The parent requested a handoff for latest-main integration rather than further old-base browser runs. Both subsequent full post-rebase rounds passed this case.
- `actual-app-ad-isolation.json`: request observations, original CSP events, native audits, frame geometry, error documents, exact source association and navigation cleanup checkpoints. Long static data URLs are represented by lengths and SHA-256 digests; complete raw URLs remain in the ignored report attachments.
- `static-data-sandbox-canaries.json`: harmless inline canary results for host access restrictions, absent private host addresses in document URL/baseURI/referrer, destruction of timer contexts, repeat mount cardinality and a local mobile native card.
- `verification-notes.json`: initial failed observations, the successful reruns and remaining limits. The initial cold dev Home response took about 5.5 seconds, exceeding the original 5-second URL expectation; only URL expectations changed to 30 seconds. Frame cleanup and repeat instance assertions were retained. The first enabled observation also failed because it expected literal `data` in the redacted CSP field; that failure and the diagnostic probes are preserved.
- `tesco-ai-news-article.png`: actual application article screenshot from the successful post-rebase complete default-off run, with no advertisement contexts.

The standalone fixtures retain the shipped document CSP, transport and iframe sandbox, replace external loader tags with harmless static inline code before mounting, and have no parent application CSP. They test browser isolation primitives; they do not run actual supplier scripts or certify the component with real inventory. The host fixture carries a synthetic private query/hash, and neither encoded nor decoded child document addresses contain it. Parent DOM/listener access, cookies, storage, popups and top navigation are denied; destruction stops the canary interval and repeated mounts keep one native iframe. The mobile card is a local fixture, not a supplier advertisement.

## Commands and report paths

All browser commands use the repository's public project only. `E2E_USE_PRODUCTION_BUILD` is unset; Playwright owns and shuts down the separate dev server. The root `.env.local` template is read by the existing configuration. A nonfunctional `RESEND_API_KEY` fixture only satisfies the server constructor; no email operation is invoked.

```powershell
$env:NEXT_PUBLIC_SAAS_URL='http://127.0.0.1:3018'
$env:RESEND_API_KEY='re_blog_build_fixture_only'
Remove-Item Env:E2E_USE_PRODUCTION_BUILD -ErrorAction SilentlyContinue
$env:BLOG_ADS_ENABLED='true'
$env:BLOG_NATIVE_ADS_ENABLED='true'
$env:PLAYWRIGHT_HTML_OUTPUT_DIR='<worktree>/output/playwright/blog-ads/on-verified/html'
$env:PLAYWRIGHT_JSON_OUTPUT_FILE='<worktree>/output/playwright/blog-ads/on-verified/report.json'
$env:PLAYWRIGHT_HTML_OPEN='never'
node node_modules/.pnpm/@playwright+test@1.62.1/node_modules/@playwright/test/cli.js test --config apps/saas/playwright.config.ts --project public --reporter=line,html,json --output output/playwright/blog-ads/on-verified/results blog-ads.public-routes.spec.ts
```

The latest complete runs use the same command with all three output paths changed to `output/playwright/blog-ads/post-rebase-off/` or `post-rebase-on/`. The off run unsets both advertisement variables; the on run sets both to `true`. The server and flags change sequentially, never concurrently, and the source files remain unchanged.

The historical complete default-off run unsets both advertisement variables and uses `output/playwright/blog-ads/off-final/`. The historical targeted default-off run also unsets both variables, uses `output/playwright/blog-ads/off-data-transport/`, and adds:

```text
--grep "server kill switch|publishes one canonical|AI News filters|standalone data document sandbox"
```

Original failed runs remain in `output/playwright/blog-ads/off/`, `on-final/` and `csp-audit-probe/`; the successful exact frame-owner diagnostic is in `csp-frame-owner-probe/`. These directories contain full JSON/HTML reports, logs and failure media and are ignored rather than committed.

The final focused unit command passed **8 files / 67 tests**:

```text
pnpm --filter saas exec vitest run modules/public-content/components/BlogAds.test.tsx modules/public-content/lib/blog-ads.test.ts modules/public-content/lib/tesco-news.test.ts modules/public-content/lib/blog-content.test.ts modules/public-content/components/BlogDirectory.test.tsx modules/public-content/components/PublicMarkdown.test.tsx app/public-routes.test.tsx app/sitemap.test.ts
```

Cloudflare build guards passed **9 tests**:

```text
node --test apps/saas/cloudflare/build-network-guard.test.mjs apps/saas/cloudflare/linux-build-cleanup.test.mjs apps/saas/cloudflare/linux-build-policy.test.mjs
```

The pre-integration final type command `pnpm --filter saas type-check` passed after its browser servers stopped. The corresponding earlier logs are in `output/playwright/blog-ads/unit-final-data-transport.log`, `cloudflare-guards-final.log` and `type-check-final.log`. Scoped formatting, lint and `git diff --check` cover the final test changes. The parent repeated the unit, guard, type and production build checks after main integration; the final two browser rounds followed that verification. All source-generation tasks were serialized. The `app-checks` JSON/Markdown evidence was formatted with the repository's Oxfmt without changing its observed values.
