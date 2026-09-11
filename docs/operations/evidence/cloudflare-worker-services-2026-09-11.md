# Cloudflare Worker service provisioning — 2026-09-11

This evidence covers the three services requested for the Workers deployment profile. It does
not certify or perform the complete website/background runtime cutover.

Account: `44c8c5cb3ce2004d398ff271836bdd2e`.

## Resource state

| Resource                      | State                    | Evidence                                                                                                                                                                            |
| ----------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Images transformation binding | Verified in Cloudflare   | Authenticated temporary Worker resized a 64 × 48 PNG to a 32 × 24 WebP and applied an image overlay; output metadata and nonempty encoded bytes verified.                           |
| Private website cache R2      | Provisioned and verified | `ezimageai-web-cache-production`; managed public URL disabled; no custom domains. Worker write/read comparison and deletion passed.                                                 |
| Hyperdrive                    | Provisioned and verified | `ezimageai-postgres-production`; strict origin certificate verification, disabled query caching, connection limit 10. A real Worker read the production database using `ezpic_app`. |

The cache bucket is separate from `ezimageai-media-production` and
`ezimageai-avatars-production`. The creation requested the APAC location hint and Standard
storage class. The account ID, cache bucket name and Hyperdrive ID were added to ignored
`.env.production.local`. The selected profile is `workers`, with its matching dispatch URL and
environment identifier. Generation, guest and billing feature gates remain disabled.

The initial Images and R2 verification completed at `2026-09-11T09:27:57.023Z`. The final check
of all three services completed at `2026-09-11T10:22:36.781Z`. The temporary Worker
required a random bearer secret; an unsigned request returned 404 and the authenticated probe
returned 200. The probe accepted no arbitrary URL, SQL, object key or user image. R2 fixture
objects were deleted by the probe. Local sanitized evidence is retained under
`.wrangler/worker-services-probe/`.

The temporary Worker `ezpic-resource-probe-20260911` was subsequently deleted and its absence
verified through the Workers API after both verification runs. The successful local
authorization command also exited. No verification Worker or task-owned authorization
listener remains running.

## Hyperdrive configuration and real database check

The resource uses the existing `ezpic_app` database role on
`db.cresrmesgalqdgbxtyvm.supabase.co:5432`, database `postgres`. The existing official
Supabase root CA was uploaded, `verify-full` is required, query caching is disabled, and the
origin connection limit is 10. The resource was read back from Cloudflare to verify these
settings after creation.

| Setting                 | Value                                  |
| ----------------------- | -------------------------------------- |
| Hyperdrive ID           | `100be79adc9a492a9f1d9fbc4e780651`     |
| Hyperdrive name         | `ezimageai-postgres-production`        |
| Uploaded CA ID          | `c51980df-7b36-4b89-b77d-da733830a8b3` |
| CA name                 | `ezimageai-supabase-ca-2021`           |
| CA expires              | April 26, 2031                         |
| TLS mode                | `verify-full`                          |
| Query caching           | Disabled                               |
| Origin connection limit | 10                                     |

The authenticated cloud probe used `env.HYPERDRIVE.connectionString` without an origin
`DATABASE_URL` Worker secret. Its read-only transaction returned database `postgres`, role
`ezpic_app`, and 43 completed Prisma migrations. It did not modify application data.

The earlier certificate-management HTTP 403 was resolved after the user approved a fresh
device authorization. Only `ssl_certs:write` was added to the existing scopes. No TLS
verification setting was weakened.

## Prepared deployment configuration

`pnpm cloudflare:prepare production` completed successfully and wrote the ignored artifacts
under `.wrangler/deploy/production/workers/`. Subsequent assertions verified:

- Both website and jobs use the actual `HYPERDRIVE` ID and the `IMAGES` binding.
- The website uses the separate `NEXT_INC_CACHE_R2_BUCKET` and a matching self-service binding.
- Neither configuration contains a Container resource.
- Origin database credentials and local CA paths are excluded from Workers secrets.
- The selected dispatch URL belongs to `ezpic-workflows-workers-production`; its environment
  identifier and dispatch secret agree across the generated runtime configurations.
- Generation, guest and billing remain disabled in both generated configurations.

The original Container dispatch URL/environment identifier is retained locally in ignored
`.wrangler/worker-services-original-dispatch.json` for explicit rollback preparation. Legacy
deployment artifacts were not overwritten. The new files prepare a future application rollout;
they do not change the currently deployed application.

## Production and cost boundaries

Live API checks confirmed the existing website Worker is `ezimageai-web-production`, version
`ca8a6a56-d28f-4f68-8bcf-61e49b638bd1`, and the jobs Worker is `ezpic-workflows-production`,
version `57db3d1f-69fb-4986-ba0b-d00994eeb2a7`; both versions are active at 100%. These are the
existing Container-based deployments. The future profile's `ezimageai-site-production`
website name is a different Worker identity and requires an explicit domain cutover.

No production application Worker was redeployed. No Images paid subscription or hosted-image
storage was purchased. The binding succeeded with the account's existing entitlement; the
current OAuth credentials cannot read the Images account subscription, so its exact plan and
remaining monthly allowance were not independently verified. Images Free's published quota
is 5,000 unique transformations per month, shared across account usage. Workers Paid includes
Hyperdrive without a separate usage charge. R2 storage and operations use the account's shared
allowance and normal usage pricing; creating a separate bucket does not create a fixed fee.

Official references retrieved on September 11:

- [Images binding](https://developers.cloudflare.com/images/optimization/binding/)
- [Images pricing](https://developers.cloudflare.com/images/pricing/)
- [Hyperdrive TLS and CA configuration](https://developers.cloudflare.com/hyperdrive/configuration/tls-ssl-certificates-for-hyperdrive/)
- [Hyperdrive pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/)
