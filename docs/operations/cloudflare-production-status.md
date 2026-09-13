# EzPic production setup status — 2026-09-12

The Workers production deployment is live at [ezimageai.com](https://ezimageai.com).
Payment configuration and active Worker versions were checked at **06:12 UTC on September 12, 2026**. The website uses
OpenNext on Workers; background jobs use Workers and Workflows. Both legacy Containers
are inactive and their old maintenance schedule is absent.

**Generation and guest generation remain disabled. Billing is enabled for sandbox payments.**
At the operator's explicit request, the existing production Workers use PayPal `sandbox`
and Waffo `test`, with test products and billing snapshots in the existing database.
Both providers have a test webhook at `https://ezimageai.com/api/webhooks/payments`.
This is not live-payment certification: a complete online sandbox payment and credit-fulfillment
test remains `NOT_COMPLETED`, and `/api/ready` still returns HTTP 503.

## Active deployment

| Component            | Current state                                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Public website       | `ezimageai-site-production`, canonical domain `ezimageai.com`                                                                            |
| Website version      | `c2f19eb5-cdf5-43d8-9d2b-137af0e00215`, active at 100%                                                                                   |
| Website build/source | `b6dcd4281c5bc78cd5b27e5bf2a4d29a3e44346b`; September 12 secret update preserved the deployed code                                       |
| Background Worker    | `ezpic-workflows-workers-production`                                                                                                     |
| Background version   | `71c349df-fc3f-49c7-8365-45aa1ff79d08`, active at 100%                                                                                   |
| Background source    | `b6dcd4281c5bc78cd5b27e5bf2a4d29a3e44346b`; September 12 secret update preserved the deployed code                                       |
| Workflow             | `ezpic-jobs-workers-production`; minute maintenance enabled                                                                              |
| Workflow execution   | The five most recent instances were complete at the September 12 06:12 UTC check                                                         |
| Hyperdrive           | `ezimageai-postgres-production`, ID `100be79adc9a492a9f1d9fbc4e780651`; verified origin TLS, query caching disabled, connection limit 10 |
| Images               | Bound to website and Workers jobs; live image transformation verified                                                                    |
| Website cache        | Private `ezimageai-web-cache-production`; 18 initial cache entries populated for the final build                                         |
| Private media        | Existing `ezimageai-media-production` and `ezimageai-avatars-production` remain separate from the cache                                  |

Supabase remains PostgreSQL only, Better Auth owns authentication, and R2 stores private
media. No new Images storage subscription was purchased. The prepared `workers` profile
contains no Container resources. The optional `hybrid` profile retains the existing Sharp
jobs runtime for a future controlled switch.

## Verified at the September 11 cutover

- The exact website source passed all five jobs in [main CI run 34594183611](https://github.com/Micmyw/ez-image-ai/actions/runs/34594183611): quality/contracts/artifact builds, PostgreSQL integration, production build, mock E2E, and dependency/secret scan.
- Fresh Linux OpenNext packaging, final workerd artifact smoke checks and secret scanning passed. Runtime secrets and build-only auth/mail placeholders are absent from the final artifacts; the embedded environment fallback is empty.
- Live desktop and mobile checks returned 200 on home, Docs and login, with no page JavaScript exceptions, failed same-origin requests or horizontal overflow.
- Health, anonymous auth session and catalog queries passed. Page/session caching remains private or no-store; hashed JavaScript assets are immutable.
- The actual website image optimizer returned a 256 × 320 WebP through the Images binding. The private cache has no managed public URL or public custom domains.
- Signed background dispatch and same-key completion checks passed with a read-only missing-attempt probe. Unsigned, expired and wrong signatures returned 401. Automatic maintenance has completed successfully.
- Google/GitHub authorization start, canonical callback, Secure/HttpOnly state cookies, provider sign-in pages and cancellation checks passed after domain cutover. Token exchange and a signed-in account session remain unverified.
- Configured GA4 and Clarity scripts each loaded with HTTP 200 at 11:46 UTC. Dashboard ingestion remains unverified. A separate Cloudflare-injected analytics beacon is blocked by the current CSP; it does not affect the verified GA4/Clarity script loading or core application routes.
- The temporary deployment probe was deleted and its absence verified at 11:46 UTC.

The [deployment evidence](evidence/cloudflare-workers-deployment-2026-09-11.md) records
versions, cutover timing, checks and rollback state. Earlier
[service provisioning evidence](evidence/cloudflare-worker-services-2026-09-11.md)
records the live Images, Hyperdrive and R2 resource checks.

## Earlier integration evidence

The [pre-cutover snapshot](https://github.com/Micmyw/ez-image-ai/blob/728c72cac691b0ff952ba5d49d3b7e3fac33a5ac/docs/operations/cloudflare-production-status.md)
preserves the September 10–11 Container deployment, image digests and integration evidence:
43 database migrations, database-role isolation/RLS and TLS, private R2 write/read/delete,
Kie credit lookup, Sightengine requests, verified Resend sender configuration, OAuth setup,
and a local Sentry SDK ingestion check. Those historical checks are not a fresh certification
of every integration on Workers. The cutover drain query reconfirmed 43 completed migrations
and no active business work.

Both old Container applications and their images remain available for rollback, but their
instances are inactive. The old background cron is absent. Use the drain procedure in the
[Workers profiles runbook](cloudflare-workers-profiles.md) before any profile switch;
retaining rollback resources does not certify a rollback under production load.

## Remaining before full product launch

| Area                 | Remaining verification or configuration                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Google/GitHub login  | Complete real account authorization, token exchange and an application session; verify provider publishing/audience settings                                                               |
| Mail/support         | Verify application verification/reset-email delivery and support forwarding receipt; no email was sent by this deployment                                                                  |
| Generation           | Exercise private upload → quote/reservation → dispatch → provider → moderation → private storage/settlement, including failure recovery and catalog/cost evidence                          |
| Payments             | Sandbox credentials, products and snapshots are configured; verify complete online checkout/fulfillment, replay and refunds, then provision Live/Prod configuration before real collection |
| Guest trial          | Verify Turnstile, abuse controls, sponsor budget and privacy/cleanup before enabling guest generation                                                                                      |
| Monitoring/analytics | Verify deployed exception capture, alert receipt and Sentry/GA4/Clarity/PostHog dashboard visibility; PostHog retains its consent gate                                                     |
| Operations           | Complete load, recovery and rollback evidence plus launch-validator inputs, support/GSC and budget/alert thresholds                                                                        |

The September 11 cutover preserved `MEDIA_GENERATION_ENABLED=false`, `GUEST_MEDIA_ENABLED=false`
and `BILLING_ENABLED=false`. The September 12 payment configuration changed billing to `true`
for PayPal Sandbox and Waffo Test; the two generation controls remain `false`. Its database
changes added only 20 billing-plan snapshots, with no customer or credit-ledger mutations.
No account creation, checkout, paid generation or email was submitted by the configuration checks.
Infrastructure deployment is complete; the remaining product launch checks above are `NOT_COMPLETED`.
