# EzPic production setup status — 2026-09-11

This is a provisioning and verification snapshot, not full launch certification.
This snapshot was recorded on `codex/cloudflare-site-setup` before Git publication; consult the
repository history for subsequent merge/push state. Cloudflare deployments were explicitly
authorized separately.
Initial integration evidence was recorded on September 10; Google/GitHub OAuth and basic Sentry
configuration and the latest deployment identifiers were verified on September 11. This is not a fresh audit of every
previously provisioned service.

## Provisioned and verified

| Component              | Evidence                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Supabase               | Free `ezimageai-production`, project `cresrmesgalqdgbxtyvm`, Singapore; dedicated `ezpic_app` login                                              |
| Database schema        | All 43 canonical Prisma migrations applied; migration status current; Prisma schema diff reports no difference                                   |
| Database isolation     | All 56 app-owned public tables have RLS; `anon` and `authenticated` have zero table privileges                                                   |
| Database TLS           | Official Supabase CA with `verify-full`; actual Prisma/pg queries passed locally, inside Node images and through a cloud job                     |
| Supabase advisors      | No WARN/ERROR security findings after fixed function search paths; 56 intentional INFO no-policy findings for backend-only tables                |
| R2                     | Both production buckets passed write/read/delete; test objects removed; managed public URLs disabled and no public custom domains                |
| Kie                    | Authenticated credit query passed; API reported 80 Kie credits. No image-generation request was submitted                                        |
| Sightengine            | Real English-text and private-R2-image requests returned ALLOW using the existing adapter; temporary fixture removed                             |
| Resend                 | Replacement API key authenticated; `ezimageai.com` is verified with sending enabled and all DKIM/SPF records verified                            |
| Mail configuration     | `MAIL_FROM="EzPic <noreply@ezimageai.com>"` and the private Resend key deployed to both website and jobs runtime secrets                         |
| Google OAuth           | Client credentials deployed; live sign-in start uses the configured client and canonical callback; Google sign-in page returned 200              |
| GitHub OAuth           | Client credentials deployed; live sign-in start uses the configured client and canonical callback; GitHub sign-in page returned 200              |
| Sentry configuration   | Website server error reporting enabled; production environment and image-linked release configured; tracing, replay and log capture disabled     |
| Sentry ingestion       | A local probe using the existing server SDK initialization and production runtime configuration received HTTP 200 from the Sentry event endpoint |
| OAuth cancellation     | Both providers use Secure/HttpOnly state cookies; cancellation returned a same-origin 302 with `access_denied`; no signed-in session created     |
| Website                | Worker/domain and private website Container deployed; `https://ezimageai.com` bound to production                                                |
| Background execution   | Workflows Worker, `ezpic-jobs-production` binding and private jobs Container deployed; minute cron registered                                    |
| Signed cloud execution | Nonexistent-attempt polling probe completed in 9 seconds with an actual read-only Supabase lookup; same-key completion recheck passed            |
| Unsigned dispatch      | Public background dispatch endpoint returned 401                                                                                                 |

Supabase is used only for PostgreSQL. Better Auth continues to own application authentication;
R2 continues to store private media. No Supabase Storage or browser data API was added.

The separately requested Workers-profile services have their own
[provisioning evidence](evidence/cloudflare-worker-services-2026-09-11.md): Images transformations,
the new private website-cache R2 bucket and Hyperdrive all passed live Worker checks. Hyperdrive
uses verified origin TLS, disabled query caching and a connection limit of 10. The `workers`
production configuration is prepared; the full application remains on the Container deployment
described here. These resource checks do not certify a Workers-profile cutover.

## Deployment identifiers

| Artifact                      | Identifier                                                                |
| ----------------------------- | ------------------------------------------------------------------------- |
| Website Worker version        | `ca8a6a56-d28f-4f68-8bcf-61e49b638bd1`                                    |
| Website Container application | `a03c3181-735b-4cdd-9bd7-a43181c010d3`                                    |
| Website image digest          | `sha256:b67717fcfbac05b1f998251b78584b9bdc2c8b4cd10a081ea07a0edf4cb9352d` |
| Background Worker version     | `57db3d1f-69fb-4986-ba0b-d00994eeb2a7`                                    |
| Jobs Container application    | `a03e489d-3855-429e-9228-c672a2c5dcc8`                                    |
| Jobs image digest             | `sha256:8839f20b4f889690e486b63c37c573b23c6bc1d5f24f36c87a4d0daed9e36776` |
| Read-only workflow probe      | `job-5349d0ac04cb05bfeebc9cc741b41dbb5963562f0f706361a3fb0fbb68fdf91b`    |
| Mail configuration rollout    | `82012a08-d3d7-42db-827e-f163576251d7`                                    |
| Post-mail runtime probe       | `job-e37325b8013f429474b3425a30e1d2aa22ac7e2a343431d382979313d6c8c76e`    |
| Google OAuth runtime rollout  | `26cfc832-f2d3-4360-a0f3-4fd876d01e04`                                    |
| GitHub OAuth runtime rollout  | `5a23dbd6-df98-420e-87c4-a90acb2da4de`                                    |
| Sentry runtime rollout        | `e4630129-8501-4b79-8581-31936a9bf609`                                    |
| Sentry project                | `4512066453504080`                                                        |
| Sentry configuration event    | `4be4b024a08c429e92538b931bc3947a`                                        |

The first background Container creation returned HTTP 401 after image upload. The later website
Container creation succeeded with the available authorization; a background retry reused the
uploaded image and succeeded. No permission expansion or application-code workaround was needed.

The mail update deployed at 10:46–10:47 UTC on 2026-09-10. Both Worker versions at that time were
confirmed active at 100%; image digests were unchanged. Wrangler skipped the unchanged Container
configuration, so a scoped website rollout reapplied the same configuration to reload runtime
secrets. Cloudflare reported the rollout completed, one healthy instance, and Container version 2.
The jobs Container was inactive after its secret update; a new read-only polling probe subsequently
completed through the deployed runtime. No image-generation or email-send request was submitted.

The Google OAuth update deployed at 05:40–05:41 UTC on 2026-09-11. Both Worker versions at that time
were confirmed active at 100%. Deployment used `--containers-rollout=none` to preserve the existing
images, followed by a scoped rollout of the website's unchanged Container configuration.
Cloudflare reported a completed rollout to Container version 3 with one healthy instance.
The live Google sign-in endpoint returned 200 and an authorization URL with the expected client ID,
`https://ezimageai.com/api/auth/callback/google`, a state value, and basic email/profile/openid scopes.
Google returned its account sign-in page without a client or redirect-URI error. A controlled
cancellation exercised the callback without exchanging an authorization code or creating a user.
Client-secret acceptance during token exchange and a complete Google-account login remain unverified.

The GitHub OAuth update deployed at 06:05–06:06 UTC on 2026-09-11. Both Worker versions at that time
were confirmed active at 100%. Preparation changed only `GITHUB_CLIENT_ID` and
`GITHUB_CLIENT_SECRET` in both runtime bundles; generation, guest and billing remained disabled.
Deployment preserved both images. A scoped website rollout completed to Container version 4
with one healthy instance. The actual website returned 200 for health and GitHub sign-in start,
with the configured client ID, `https://ezimageai.com/api/auth/callback/github`, a state value,
and the `read:user`/`user:email` scopes. GitHub returned its sign-in page with HTTP 200 and no
detected client or callback configuration error. Cancellation returned the same-origin auth error
page with `access_denied`; the matching cookie jar still had no authenticated session.
Successful token exchange and a complete GitHub-account login remain unverified. No email or
image-generation request was submitted by this verification.

The Sentry runtime update deployed at 07:19 UTC on 2026-09-11. Both latest Worker versions were
confirmed active at 100%, preserving both image digests. The website rollout completed to Container
version 5 with one active instance. Strict-TLS public-IP requests returned 200 for health, login and
the auth-session endpoint; full-launch readiness still returned 503 `not_ready`.
Only monitoring settings and the release identifier changed. The native SDK environment is
`production`, and release `ezimageai-web@b67717fcfbac` identifies the deployed website image.
`SENTRY_TRACES_SAMPLE_RATE=0`; the initialized server SDK also had no Replay integration, logs
disabled and `sendDefaultPii=false`. Existing redaction/release tests passed (2 tests).
A local SDK probe loaded the same server initialization with the production runtime configuration.
Sentry accepted one controlled exception event (and its SDK session envelope) with HTTP 200 and
no rate-limit response. The test event is named `EzPicSentryConfigurationCheck` and explicitly tagged
`execution_location=local-sdk-probe`. No account subscription or billing setting was changed.

## Verification limits

- Sentry ingestion is verified from the local SDK probe. Capturing an actual exception from the
  deployed website, seeing the issue in the authenticated Sentry dashboard, and receiving an alert
  remain `NOT_COMPLETED`. The jobs runtime received the same environment bundle, but it currently
  has no independent Sentry SDK initialization; this deployment does not certify background-job
  error capture. No browser Replay or client-side Sentry initialization was added.

- Full workspace type checking (22 tasks), lint, formatting and the unit-contract runner passed.
  The final deployment-environment correction also passed the 16 focused web-host tests.
- Both Docker images build, run as UID 1000 and can query Supabase using TLS. The website runtime
  image environment contains no baked database, provider, auth, mail or storage credential.
- Local browser checks using the canonical origin routed to the local production image passed on
  home, Docs and login, plus a mobile home viewport; no page script errors or horizontal overflow.
- Cloudflare and Google public DNS resolve the apex to Cloudflare. HTTPS requests using these
  resolved addresses passed on home, Docs, login, auth session and health without disabling TLS.
  `/api/ready` returned the expected 503 `not_ready`. The current Windows network path still failed
  ordinary browser/hostname TLS connections; browser access through that path is not verified.
- Minute cron registration is verified. Automatically scheduled maintenance execution, complete
  task coverage, durable retry/sleep, idle stop/restart and load/cost certification are not yet
  certified by the read-only polling probe.
- No production users, credit grants, paid generation, checkout or outgoing emails were created
  by these checks. Tests did not run against the production database with destructive fixtures.
- After the mail update and website rollout, strict-TLS public-IP checks again returned 200 for
  `/api/health` and `/api/auth/get-session`; `/api/ready` still returned the expected 503.
- Resend domain/API validation and secret deployment are verified; actual verification/reset email
  delivery is `NOT_COMPLETED`. Resend receiving was disabled at its last check. A later public DNS
  query on September 11 now returns three Cloudflare Email Routing MX records. The support alias,
  forwarding destination and actual receipt remain unverified; `NEXT_PUBLIC_SUPPORT_EMAIL` is empty.

## Remaining configuration before full launch

GA4 and Clarity browser integration and their local production identifiers were prepared on
September 11. At the user's request, both now load automatically; application-level Clarity
masking, page exclusions and navigation stops have been removed. PostHog keeps its consent gate.
These changes have not been deployed with the website. Focused tests, an isolated browser
check and public tag availability passed; deployed website ingestion and dashboard visibility
remain `NOT_COMPLETED`.

PostHog project `604257` (US Cloud) is now configured locally with the supplied project token
and `https://us.i.posthog.com` collection host. One synthetic `landing_viewed` event sent through
the existing sender returned HTTP 200; response-body acknowledgement and dashboard visibility
remain unconfirmed. Local evidence is in `.wrangler/evidence/posthog.json`, and all 19 focused
product-event/consent tests passed. Rebuild and deploy the website to apply its browser settings. See
[website analytics](./website-analytics.md) for consent, recording scope and free-plan details.

| Area         | Required action                                                                                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mail         | Verify actual application verification/reset-email delivery to a controlled inbox; credentials, sender and domain configuration are complete                               |
| Google login | Complete a real Google-account authorization, token exchange and application session; verify the Google audience/publishing settings for public launch                     |
| GitHub login | Complete a real GitHub-account authorization, successful token exchange and application session; credentials and authorization-start checks are complete                   |
| Support      | Verify forwarding and actual receipt for `support@ezimageai.com`, then set `NEXT_PUBLIC_SUPPORT_EMAIL`; Cloudflare MX records are now present                              |
| Payments     | Configure the selected provider, product/plan IDs and verified webhooks; complete replay/refund evidence before enabling billing                                           |
| Generation   | Run the existing private asset → quote/reservation → dispatch → generation → moderation → storage/settlement path and record catalog/cost evidence                         |
| Monitoring   | Confirm Sentry dashboard visibility, deployed-request exception capture and alert receipt; website configuration and local SDK ingestion are complete                      |
| Operations   | Verify deployed PostHog events/dashboard visibility, support/GSC, budget/alert thresholds and the deployment/environment/evidence records required by the launch validator |
| Guest trial  | Complete Turnstile, abuse controls, sponsor budget and guest privacy/cleanup evidence if enabling guest generation                                                         |
| Release      | Run the remaining staging/load/recovery/rollback and live browser checks from the existing launch checklist                                                                |

`MEDIA_GENERATION_ENABLED`, `GUEST_MEDIA_ENABLED` and `BILLING_ENABLED` remain `false`. The public
site being deployed does not mean email delivery, generation or paid checkout is verified.
Configuration and deployment commands are in [the hosting runbook](./cloudflare-hosting-runbook.md).
