# Passive advertising observation, 2026-10-11

Both supplied loaders returned empty bodies. Advertising must stay disabled: this run cannot certify the specific widget's native format, dimensions, responsive behavior, creatives, popup/redirect behavior, or cookie inventory. The existing app CSP also blocks the supplied script domains. No production security policy was changed.

The initial supplier fixture below used `srcdoc`; it is historical observation, not the final product transport. A later harmless [fallback-base-URL probe](srcdoc-base-uri-probe.json) found that opaque `srcdoc` exposes the embedding URL through `document.baseURI`, despite an empty referrer. A fixed `<base>` is removable and does not reliably hide the fallback. The product preparation now uses only a static `data:` document, which did not inherit the probe host's synthetic query/fragment. The unchanged app `frame-src` blocks that whole data document, so it cannot currently display inventory. The public canonical itself is not treated as confidential; preventing private query values from leaking is the purpose of this small correction. No real private data or vendor payload was used in this follow-up.

The [probe explanation and limits](srcdoc-base-uri-probe.md) also records that `location.ancestorOrigins` can reveal the public parent origin, without its path or synthetic query. The correction protects potentially private address values; it does not hide the public hosting origin.

The parent supplied separately verified approval-email evidence: Adsterra approved `ezimageai.com` Native Banner placement `31667650` and Banner 728 × 90 placement `31667651` at 2026-10-11 03:26:18 UTC (Gmail message `1a128ff3f8f42966`). This supports the approved ad types. The email does not map either placement to the supplied loader hash or host, and it does not certify runtime behavior, mobile compatibility, or revenue. No account or ad-unit changes were performed.

## What was tested

- Static HTTP reads of both exact user-provided `invoke.js` URLs, with the default HTTP client and a standard Chromium user agent. The saved HTTP evidence at approximately 03:36 UTC records status 403, JavaScript content type, and zero body bytes for both URLs. Empty files are intentional; they are not reviewed vendor source.
- Independent Playwright 1.62.1 Chromium contexts with no cookies, account state, extensions, prompt, photo, signed resource, or product API. No user Chrome tabs were used. No ad was clicked, no signup/payment was performed, and all temporary browser contexts were closed.
- A local host fixture at 1280 × 900 and 390 × 900. The supplied snippets ran only in opaque `srcdoc` frames with `sandbox="allow-scripts"` and `referrerpolicy="no-referrer"`. The frames did not receive `allow-same-origin`, popups, forms, or top-navigation permission.
- The same fixture with the app's production `script-src` and `frame-src` directives copied from `apps/saas/next.config.ts`. This is a fixture reproduction, not a live app certification.
- Static Playwright HTTP API reads at approximately 03:41 UTC returned status 200 for both URLs, but also zero body bytes. The response differences are recorded without assuming the cause.
- Final public HTTP reads at approximately 03:53 UTC supplied `Referer: https://ezimageai.com/` and the same standard Chromium user agent. Both exact loaders still returned status 403 and zero body bytes. No response payload was executed, and no production page was visited.

Chromium used its browser sandbox. The launch supplied only headless, remote debugging pipe, first-run suppression, and no-startup-window switches, with Playwright's default switches ignored. No browser security bypass flag was supplied.

## Results and limits

| Evidence                                               | Result                                                                                                                  | Meaning                                                                               |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `banner-invoke-fetch.json`, `native-invoke-fetch.json` | HTTP 403; `Content-Length: 0`                                                                                           | No vendor source available from these reads                                           |
| `browser-api-fetch.json`                               | HTTP 200; `Content-Length: 0`; no `Set-Cookie` header                                                                   | Browser HTTP client also received no executable vendor source                         |
| `sandbox-1280.json`, `sandbox-390.json`                | Per-frame Resource Timing entries name both loader URLs; bodies show no ad content                                      | The exact loaders were attempted in strict frames; no real creative was observed      |
| `csp-1280.json`, `csp-390.json`                        | Console explicitly reports `script-src` violations for both advertising domains                                         | A sandboxed `srcdoc` does not avoid the embedding app's script policy                 |
| All frame observations                                 | Opaque origin `null`; reading `document.cookie` throws `SecurityError`                                                  | These frames cannot read the host's cookie via same-origin DOM access                 |
| All fresh browser contexts                             | No stored cookies, popups, notifications, vendor event listeners, or vendor timers observed during each 8-second window | Empty or blocked loaders cannot prove how real ads behave later                       |
| Desktop fixture                                        | Banner container 728 × 90; widget container 900 × 500                                                                   | These are local reserved container sizes, not observed creative dimensions            |
| Mobile fixture                                         | Banner CSS-hidden; widget container 350 × 500; document width 390 equals viewport width 390                             | No host overflow in this fixture; the widget's actual responsiveness remains untested |

`publisher-origin-fetch.json` records the last header-specific check, with `publisher-origin-banner.response.txt` and `publisher-origin-widget.response.txt` intentionally empty. Supplying the public publisher-origin Referer did not produce vendor source in that check; the response cause remains unknown.

Playwright request/response events did not include opaque `srcdoc` loader fetches in this run; per-frame Resource Timing captured their URL names instead. A cross-origin Resource Timing `responseStatus: 0` is opaque information and does not establish HTTP success, failure, or response size. The static HTTP statuses above come from the separate HTTP reads. Nested advertiser requests/cookies cannot be inventoried without an actual vendor payload.

The CSS-hidden desktop frame still has a Resource Timing entry on mobile. Hiding a mounted frame alone does not prevent its script fetch. The product implementation should avoid creating the desktop ad frame until its width requirement and consent are satisfied.

## Supplier guidance versus this isolation

The supplied first snippet explicitly declares `format: iframe`, width 728, and height 90. [Adsterra's banner guide](https://adsterra.com/blog/how-banner-ads-make-money/) says fixed banners do not adapt to screen width, recommends mobile and desktop code variants, and asks publishers to copy the issued snippet unchanged. No new mobile slot or parameters were invented here.

The second snippet has an async loader and a matching `container-…` div, consistent with a rendered widget. Its specific ad-unit format remains unverified. [Adsterra's native banner guide](https://adsterra.com/blog/turn-a-profit-with-native-banners/) describes native blocks as image-and-title groups that adapt to devices, with account-level layout customization. That general description does not certify this key's behavior.

Both supplier guides describe inserting snippets into the page body. This run used a stronger opaque iframe boundary. That boundary prevents host DOM/cookie access and denies popup/top-navigation permissions; it may also prevent functionality the vendor expects. Compatibility and revenue attribution are unverified. No unrestricted direct-body supplier execution was attempted after source retrieval returned no code.

## Reproduction and pending work

The observer uses the existing repository dependency installation and writes only local evidence:

```powershell
node scripts/blog-ad-observation.mjs 'D:\AIProject\Gefei\SaaSTool\ez-image-ai'
```

Source parsing passed with `node --check`. Focused lint and formatting results are reported by the delegated task. Product SPA navigation, back/forward, and repeated-mount isolation are owned by the parent implementation tests; this supplier fixture is not their substitute.

Before any future activation, obtain nonempty exact-loader responses through the intended consent and isolation setup, confirm the second ad-unit format and mobile rendering, inventory the real request/cookie chains, and test actual creatives passively for prohibited behavior. Any route-scoped security-policy decision and the release window must be coordinated by the parent; the current application policy remains intact.
