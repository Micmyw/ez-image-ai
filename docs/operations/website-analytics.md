# Website analytics

Implementation: 2026-10-21. These workspace changes are local; no production migration or deployment has been performed for this change.

## Services and scope

- PostHog transport, public build variables and mandatory launch identifiers are retired. Existing private environment values and the external account are not deleted. Historical manifests can still contain an optional `posthogProject` field.
- First-party `/api/analytics/traffic` increments finite hourly counters by public path category, source category and coarse device. Requests omit credentials and referrer headers. It rejects cookies, authorization, privacy signals, known bot user agents, extra fields and foreign origins. There are no visitor IDs, IPs, raw UAs, account links, prompts, media or per-visit rows. This is best-effort JavaScript page-view measurement, not a unique-user count, impression count, bot-proof counter or payment denominator.
- Detailed `/api/analytics/events` uses the existing allowlisted event schema, server-resolved account identity and a random hashed browser cookie. The server independently checks current permission and trusted geography. Generation diagnostics contain text-length buckets, input counts, public model/options and stages, never text or file contents. Browser outcomes remain observations, not billing truth.
- `/admin/analytics` separates anonymous views, observed browsers, server registration cohorts, generation outcomes and verified financial evidence. The private Chinese report includes the top 50 generation diagnostic groups. Source/device filters apply to detailed populations. Anonymous counters use the time/device filters and always show all broad source categories: an exact detailed source such as `www.google.com` cannot be isolated from a stored `google` category. Hourly aggregates expose their rounded UTC start; rolling conversion ranges retain their original exact boundary.

## Permission and geography

`GET /api/analytics/policy` is private/no-store. Geography is read only from the proxy selected by `MEDIA_TRUSTED_PROXY_PROVIDER`. It is not embedded in cacheable public HTML. `ANALYTICS_OPT_OUT_COUNTRIES` is a comma-separated server setting; its initial default is `US`. Set it to an empty string for worldwide opt-in. Configure any additions only after checking the applicable requirements; no-cookie measurement is not a universal legal exemption. EEA, UK and Switzerland always require opt-in even if mistakenly listed. Unknown/unconfigured countries fail closed.

Explicit acceptance writes `consent=true` and `consent_version=2` for up to 30 days. Old acceptance is renewed for the revised purposes; old refusal remains effective. Regional permission writes `consent=regional` for one day and is re-evaluated on each document and every server ingestion; it is not fabricated explicit consent and does not enable blog advertising. Refusal and GPC/DNT override regional defaults. Anonymous totals do not wait for optional consent but honor refusal and privacy signals. Business records, authentication and generation are independent of the choice.

A nonmodal banner appears only where a choice is required. The global Privacy settings control reopens choices on public and account pages. Declining removes optional attribution/browser state, cancels pending events, denies vendor consent and stops Clarity including cookieless replay. Essential product storage remains available.

## GA4 and Clarity

Set the public collection IDs `NEXT_PUBLIC_GOOGLE_ANALYTICS_ID` and `NEXT_PUBLIC_CLARITY_PROJECT_ID` before building. No management keys belong in public variables. Use the existing Cloudflare prepare/build workflow; build or secret preparation is not deployment. `ANALYTICS_OPT_OUT_COUNTRIES` is a runtime server setting.

GA4 measures only allowlisted public pages with sanitized UTM page locations and origin-only referrers. Advertising signals and advertising storage are denied. Clarity covers public pages and both generation workspaces, including `/create?mode=video`; account, admin, billing and private history routes are excluded. Unexpected URL parameters or fragments disable replay. Approved editor job/videoJob references can appear in recorded URLs. Private previews, account menus and embedded private panels are explicitly masked. Native text inputs and dropdown contents are always masked by Clarity; do not mirror input text into DOM or tags to bypass this restriction.

Enable Consent Mode in the Clarity project before release and confirm new recordings. The integration sends `consentv2` with `analytics_Storage` granted only when permitted and `ad_Storage` always denied. Denial alone can retain cookieless recording, so the SDK `stop` API is also called. Deferred scripts recheck permission at load. The SDK is restarted only when permission and route allow it.

Custom tags use the `generation_` prefix: mediaKind, phase, publicModel, textLength, inputCount, supported options and bounded reason. Events include image/video editing, upload, quote/confirmation, submitted and result stages. Select these tags/events in Clarity to inspect where a journey stalls. They never call `identify` or send account IDs, raw prompts, file names or private media URLs.

Official references: [masking](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-masking), [ConsentV2](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-consent-api-v2), [client events/tags](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-api), [SDK lifecycle source](https://github.com/microsoft/clarity/blob/master/packages/clarity-js/src/clarity.ts).

## Database and verification

Apply `20261021100000_growth_event_funnel` followed by `20261021120000_anonymous_traffic_diagnostics` before deploying the consumers. Both tables use the existing private application-role/RLS boundary. Counters and detailed observations older than 90 days are removed in bounded batches on new activity; idle sites purge on subsequent activity. The aggregate endpoint has a global 12,000-request/minute ceiling; it is coarse protection, not a human-traffic guarantee. Client page deduplication is memory-only.

Focused tests cover region trust, explicit refusal/version renewal, source sanitization, anonymous credentials, immutable registration attribution, SDK start/revoke, generation payload limits and private Chinese labels. The migration and atomic SQL were exercised on an isolated local PGlite PostgreSQL engine. Browser tests intercept external vendors and business APIs; this validates local integration behavior, not actual Microsoft/Google ingestion, payment, generation or dashboard visibility. Production migration, deployment and authenticated vendor-dashboard verification are NOT_RUN.

Final local verification on 2026-10-21: 151 SaaS, 38 API, 122 web-host and 2 Cloudflare build-policy checks passed. Both isolated PostgreSQL integration cases passed, including the independent anonymous source categories, and the 8 affected Chinese-admin checks passed again. Three browser scenarios passed for opt-in, regional permission and privacy signals, including first-touch persistence across navigation and optional-cookie cleanup after refusal. SaaS, API and web-host type checks, affected-source formatting/lint and `git diff --check` passed. Temporary browser and database processes were stopped after verification.

See [conversion and attribution](./conversion-funnel-attribution.md) for cohort and payment evidence semantics. Historical September PostHog connectivity evidence is retired and does not certify this implementation.
