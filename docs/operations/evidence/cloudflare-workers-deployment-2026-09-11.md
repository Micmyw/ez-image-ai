# Cloudflare Workers production deployment — 2026-09-11

The explicitly authorized production deployment is complete at
[ezimageai.com](https://ezimageai.com). Website and background execution now use the `workers`
profile. This evidence certifies the deployment and the specific checks below, not full
product launch. Generation, guest generation and billing stayed disabled throughout.

## Deployed artifacts

| Component                     | Identifier                                                         |
| ----------------------------- | ------------------------------------------------------------------ |
| Website Worker                | `ezimageai-site-production`                                        |
| Website version, 100%         | `b11eaeb2-2b9c-409c-abfd-6ce57eef4492`                             |
| Website build/source          | `f8980809152d59d10cd5e31e9fe0ad481be49667`                         |
| Website JavaScript SHA-256    | `d9441d7919ec1743f3ce736f22084ee8c604eaa2a42605720931080d3a1e00f5` |
| Background Worker             | `ezpic-workflows-workers-production`                               |
| Background version, 100%      | `371f4238-1b37-40b5-828b-91bae3f38167`                             |
| Background source             | `728c72cac691b0ff952ba5d49d3b7e3fac33a5ac`                         |
| Background JavaScript SHA-256 | `2a6fbcd84fa8ebf233356f1fc6b5d97232782a72cdd80394b4deda3f6d1c9f8a` |
| Workflow                      | `ezpic-jobs-workers-production`                                    |
| Domain record                 | `5880f55b2a1eed323e167e48aa3ac0fb4d97e6c2`                         |
| Hyperdrive                    | `100be79adc9a492a9f1d9fbc4e780651`                                 |
| Private website cache         | `ezimageai-web-cache-production`                                   |

The website was built from an explicit Git archive on Linux/WSL using Node 24.14.1 and
pnpm 11.3.0. Later website fixes did not change the background artifact or require redeploying
jobs. Concurrent unrelated working-tree changes were excluded from all deployment archives.
Subsequent operations-documentation commits do not change the deployed source identifiers above.

The canonical build wrapper stripped OpenNext's embedded environment fallback. The final
artifact scan found no production secrets or build-only auth/mail placeholders in JavaScript,
WASM, static assets or initial cache files. Runtime credentials were supplied through Worker
secrets. Origin database credentials remain in Hyperdrive, with verified origin TLS, disabled
query caching and an origin connection limit of 10. No Container resources exist in the new
profile. The Images binding uses private bytes without purchasing hosted Images storage.

## Cutover and drain

All times below are UTC on September 11, 2026.

| Time     | Evidence                                                                                                                                                                                                              |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10:48:57 | Read-only production drain query: 43 completed migrations; no generation jobs/attempts, upload sessions, Outbox/provider/payment events, credit reservations or media assets; no active leases or multipart transfers |
| 10:53:39 | Signed missing-attempt workflow probe completed and same-key completion was confirmed                                                                                                                                 |
| 10:58:59 | Removed the old background schedule                                                                                                                                                                                   |
| 11:00:52 | Last old workflow trigger observed during schedule propagation                                                                                                                                                        |
| 11:01:28 | Old jobs Container became inactive                                                                                                                                                                                    |
| 11:06:44 | Enabled the new minute maintenance schedule after old work drained                                                                                                                                                    |
| 11:07:43 | Moved `ezimageai.com` to `ezimageai-site-production`, preserving the existing certificate and DNS record                                                                                                              |
| 11:08    | Google/GitHub authorization-start and cancellation checks passed on the canonical domain                                                                                                                              |
| 11:23:35 | Old website Container became inactive after a scoped graceful stop                                                                                                                                                    |
| 11:37    | Final website version passed service-binding and desktop/mobile browser checks                                                                                                                                        |
| 11:46    | API readback confirmed active versions, domain, private cache, old cron absent and both old Containers inactive; new workflow had 38 completed and 0 failed instances                                                 |
| 11:46:50 | Temporary deployment probe deleted; Workers API confirmed absence                                                                                                                                                     |

The new workflow snapshot had no queued, running, paused or waiting instances. The old workflow
had no active work; its historical aggregate includes one earlier errored instance, which is
not a failure of the Workers deployment. Scheduled maintenance evidence covers its actual
execution against the empty production business queues, not loaded generation/recovery paths.

No business table was migrated by this runtime change. PostgreSQL remains the source of truth;
leases, immutable credits, Outbox delivery and uncertain-submission gates remain in existing
business code. No paid provider request, user account, checkout or outgoing email was created.

## Validation

The exact website source passed [main CI run 34594183611](https://github.com/Micmyw/ez-image-ai/actions/runs/34594183611).
All five jobs succeeded: quality/contracts/artifact builds, fresh PostgreSQL migrations and
integration tests, production builds, mock media E2E, and dependency/secret scanning. Fresh
Linux OpenNext packaging, final Wrangler bundling and final workerd artifact smoke also passed.
Mock E2E and disposable-database tests are not real provider or payment certification.

Two deployment findings were fixed in the deployed source:

- Wrangler function-name instrumentation caused `__name is not defined` in the serialized
  `next-themes` initializer. A final-artifact regression reproduced the error before
  `keep_names: false` and passed after it, including a stored dark-theme preference check.
  The generated configuration remains compatible with the preparation tool's JSON parser.
- Website CSP blocked the configured analytics scripts. The deployed policy now allows the
  specific Google Tag Manager and Clarity script hosts. All three scripts returned HTTP 200
  at 11:46:18, with no failures or CSP violations for those hosts. A separate automatically
  injected `static.cloudflareinsights.com` beacon is still blocked; Cloudflare browser RUM
  and analytics dashboard ingestion are not certified by this check.

Live checks after the final deployment:

| Check                       | Result                                                                                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home, `/docs`, `/login`     | HTTP 200; desktop 1440 × 1000 and mobile 390 × 844 had no horizontal overflow                                                                                           |
| Browser application         | No page JavaScript exceptions or failed same-origin requests                                                                                                            |
| `/api/health`               | HTTP 200, `{"status":"alive"}`                                                                                                                                          |
| `/api/ready`                | Expected HTTP 503, `{"status":"not_ready"}` while launch gates are closed                                                                                               |
| `/api/auth/get-session`     | HTTP 200, anonymous `null`, `Cache-Control: no-store`                                                                                                                   |
| `/api/media/catalog`        | HTTP 200, catalog/pricing versions present and no available products while generation is disabled                                                                       |
| Page/static caching         | HTML private/no-store; hashed JavaScript immutable                                                                                                                      |
| Website image optimizer     | HTTP 200, 256 × 320 WebP, 16,230 bytes through the Images binding                                                                                                       |
| Remote initial cache        | 18 entries from the final build populated successfully; cache bucket has public access disabled and no public custom domains                                            |
| Background signature checks | Unsigned, expired and incorrect signatures returned 401; signed execution and same-key completion passed                                                                |
| OAuth start/cancellation    | Expected Google/GitHub client IDs and canonical callbacks, Secure/HttpOnly state cookies, provider sign-in pages, same-origin cancellation and no authenticated session |

The signed probe identifier is
`job-d6a3b7846c88df8ffff09b874754b57702bd4bff89bcd9d1a9d0ed8a0a8a3a1b`.
It looked up a nonexistent attempt and did not submit a provider request or mutate a generation.

## Rollback and cleanup

| Retained legacy resource                                                      | State                                                  |
| ----------------------------------------------------------------------------- | ------------------------------------------------------ |
| `ezimageai-web-production` / version `ca8a6a56-d28f-4f68-8bcf-61e49b638bd1`   | No canonical-domain traffic; Container inactive        |
| Website Container application `a03c3181-735b-4cdd-9bd7-a43181c010d3`          | Existing definition/image retained                     |
| `ezpic-workflows-production` / version `57db3d1f-69fb-4986-ba0b-d00994eeb2a7` | Schedule absent; no active workflow work               |
| Jobs Container application `a03e489d-3855-429e-9228-c672a2c5dcc8`             | Existing definition/image retained; Container inactive |

The website Container required an explicit graceful stop after the domain switched. A temporary
bearer-protected Worker used a fixed binding and fixed `website-primary` instance to invoke
the existing Container SDK `stop()` method. It did not expose arbitrary instance selection.
Cloudflare subsequently reported the instance inactive. Both legacy images remain available;
their digests and earlier integration checks are preserved in the
[pre-cutover snapshot](https://github.com/Micmyw/ez-image-ai/blob/728c72cac691b0ff952ba5d49d3b7e3fac33a5ac/docs/operations/cloudflare-production-status.md).
Any rollback still requires the documented drain procedure; load/rollback behavior is unverified.

The temporary `ezpic-deployment-probe-20260911` Worker was deleted and its absence verified.
It accepted only fixed read-only route/image checks and the scoped legacy stop; an unsigned
request returned 404. The earlier `ezpic-resource-probe-20260911` was already deleted after
service provisioning. Local task-owned build processes and the isolated Linux build directory
are cleaned up separately from retained rollback/configuration evidence and shared tools.

Sanitized local evidence is retained under `.wrangler/workers-deployment-20260911/`, including
`artifact-manifest.json`, `drain-evidence.json`, `final-state.json`, `live-browser.json`,
`website-staged-verification.json`, `analytics-scoped.json`, `probe-cleanup.json`, build/deploy
logs and desktop/mobile screenshots. Credentials and private rollback configuration remain
ignored and must not be committed.

## Verification limits

`MEDIA_GENERATION_ENABLED=false`, `GUEST_MEDIA_ENABLED=false` and `BILLING_ENABLED=false`
remain unchanged. Full OAuth token exchange/account sessions, real generation and credits
settlement, guest abuse controls, payment checkout/webhooks/refunds, actual email delivery,
production exception/alert capture, analytics dashboard ingestion, and load/recovery/rollback
certification remain `NOT_COMPLETED`. See [production status](../cloudflare-production-status.md)
and the [Workers profiles runbook](../cloudflare-workers-profiles.md) for next-launch requirements.
