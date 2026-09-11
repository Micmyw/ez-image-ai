# Website analytics

Last checked: September 11, 2026.

## Configuration

Set these values in the ignored `.env.production.local` file:

| Variable                          | Source                                                   | Purpose                              |
| --------------------------------- | -------------------------------------------------------- | ------------------------------------ |
| `NEXT_PUBLIC_GOOGLE_ANALYTICS_ID` | GA4 web data stream, `G-...`                             | Public-page visits                   |
| `NEXT_PUBLIC_CLARITY_PROJECT_ID`  | Clarity project settings                                 | Standard website heatmaps and replay |
| `NEXT_PUBLIC_POSTHOG_KEY`         | PostHog project API key, `phc_...`                       | Existing restricted product events   |
| `NEXT_PUBLIC_POSTHOG_HOST`        | `https://us.i.posthog.com` or `https://eu.i.posthog.com` | Match the project's region           |
| `EZPIC_POSTHOG_PROJECT_ID`        | PostHog project ID                                       | Launch evidence identifier           |

These are public collection identifiers. A PostHog personal API key is not needed.
The GA4, Clarity and PostHog identifiers supplied for EzPic are configured locally. PostHog uses
project `604257` in US Cloud, with collection host `https://us.i.posthog.com`; its project token
is stored only in the ignored production environment file. Never place a service-management
credential in a `NEXT_PUBLIC_` variable.

The website's browser bundle reads `NEXT_PUBLIC_` values at build time. Rebuild and deploy the
website after changing them; updating only runtime secrets is insufficient. The shared deployment
allowlist includes both analytics IDs. Legacy website Container builds also accept the Clarity ID.
Use the selected hosting profile's preparation and build flow in the
[hosting runbook](./cloudflare-hosting-runbook.md). Do not switch hosting profiles as a side effect
of configuring analytics.

## Collection behavior

- GA4 and Clarity load automatically once per document when their IDs are configured. They do
  not read the consent cookie or wait for the banner. The app does not send synthetic consent
  grants to either vendor; vendor-side settings and behavior still apply.
- GA4 tracks public page views, including public SPA navigation, using URLs with query strings
  and fragments removed. Referrers are reduced to origins, titles use the static product name,
  advertising signals are disabled, and the Google disable flag is set on private routes.
- In GA4, turn off **Enhanced measurement** for this web stream so the dashboard does not
  independently add automatic history, form, search, download or outbound-link events. The app
  sends its own page views; product conversion events use the separate PostHog transport.
- Clarity uses its standard tag across public, auth, guest, editing, account, billing and admin
  pages. There is no application route/referrer/query filter, full-page masking attribute,
  navigation stop, or late-start suppression. The app does not override Clarity's own masking
  settings or its built-in input protections. Keep or change project settings in Clarity itself.
- The cookie banner continues to control only PostHog's restricted product events. Its choice
  does not start, stop or reload GA4 or Clarity. No PostHog Replay or Self-driving is installed.

## Free-plan scope

- GA4 Standard is free; Analytics 360 is a separate enterprise product.
- Microsoft documents Clarity as free without a traffic limit.
- PostHog product analytics includes 1 million events each month. Its free allowances renew
  monthly. The free plan without a payment card stops at the limits; paid account usage and
  spending limits need to be checked separately in the account's billing page.
- PostHog Self-driving is separate: the current page offers 3 PRs per month free, then $15 per PR.
  The `@posthog/wizard self-driving` command is not required for this analytics integration.

References: [Google Analytics](https://marketingplatform.google.com/about/analytics/),
[Clarity FAQ](https://learn.microsoft.com/en-us/clarity/faq),
[Clarity masking](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-masking),
[PostHog pricing](https://posthog.com/pricing),
[PostHog Self-driving](https://posthog.com/docs/self-driving).

## Verification state

Focused consent, product-event, analytics and root-layout tests verify automatic loading for all
banner choices, unrestricted Clarity navigation, one initialization per document, absence of the
full-page mask and unchanged GA address redaction. The isolated browser check intercepts vendor
scripts; it does not prove vendor ingestion or dashboard visibility. Both configured public
vendor tag URLs returned HTTP 200 at the initial configuration check.

On September 11, the existing PostHog sender submitted one synthetic `landing_viewed` event
from a local configuration probe, and the US `/capture/` endpoint returned HTTP 200. Evidence is
stored locally in `.wrangler/evidence/posthog.json`. This verifies endpoint connectivity; the
response-body acknowledgement and dashboard visibility have not been confirmed. The focused
product-event and consent suites passed all 19 tests. No real user's consent setting was changed.

Production deployment and real dashboard verification are `NOT_COMPLETED`: the workspace is
undergoing a separate hosting migration, and these browser-code changes have not been released.
After deploying the selected, verified website build, confirm automatic loading from a clean
browser context, GA4 Realtime and Clarity data. Test PostHog consent independently.
Confirm the probe in PostHog Activity and verify actual website funnel events after deployment.
