# Image-pass production migration review package

Status: **prepared only; neither production SQL file has been executed**. Target independently identified by root: Supabase project `ezimageai-production`, reference `cresrmesgalqdgbxtyvm`, PostgreSQL 17. Root must confirm that exact target and approve this package before any production mutation. This is not permission to run all repository migrations.

## Immutable SQL artifacts

| Artifact                                                                      | SHA-256                                                            |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/database/prisma/migrations/20261019010000_image_pass/migration.sql` | `ed215fd662ff62a67595a59dab6e3c62301dc0a7832bb29bc5e90ed411fbe5ab` |
| `docs/operations/image-pass-paypal-provision.sql`                             | `aab762175e1cdb7cd8f38608107611ca481341d44784a7733a50ac67511d003e` |

Recalculate hashes from the reviewed final commit before execution. Each file contains its own `BEGIN` and `COMMIT`. Preserve files intact and stop on error. Do not split a failed transaction into individually retried statements, guess migration-history entries or replay historical migrations against production.

## Scope and compatibility

DDL adds one enum value, two nullable/defaulted columns, five independent grant/unit/reservation/ledger/adjustment tables, indexes, RLS/app-only policies and four invoker trigger functions. It also replaces two existing CHECK constraints: the positive-credit rule becomes an explicit funding rule, and the checkout snapshot rule gains IMAGE_PASS while preserving credit-pack shape. This is not exclusively new-table DDL. Existing rows are validated by replacement CHECKs.

Existing jobs receive `fundingSource='CREDITS'` by default and retain positive `creditsReserved`. The new optional checkout snapshot remains null on existing rows. Ordinary credit reservations require CREDITS jobs; pass reservations require the exact owner/job/unit binding and zero ordinary credits. Existing credit, subscription, quote TTL, asset authorization and moderation behavior remains. This feature does not introduce a price-approval expiry.

The five tables enable RLS and have no PUBLIC or Supabase API-role table grants. The existing server role `ezpic_app` receives explicit DML and an app-only policy when present. Read-only production catalog verification confirmed the role exists without superuser/bypass-RLS and existing generation/checkout/billing/video tables follow that private pattern. Existing table/schema privileges are unchanged.

Old ordinary-job consumers can continue reading known CREDITS jobs after this schema delta. Old consumers and generated purchase enum readers cannot safely handle new IMAGE_PASS jobs/purchases. Prevent checkout/admission until both website and jobs deployments run compatible code. An absent/inactive IMAGE_PASS billing row is only an initial-intake gate; it is insufficient as a compatibility gate once grants exist.

## Ordered procedure for approval

1. Complete independent review and official-client CI, schema-drift/build/type/lifecycle checks. Confirm a recoverable backup, target and execution role. Read catalog first: new tables/columns/enum must be absent, replaced constraints must match baseline and exact offer row must be absent. Inspect committed state before retrying any uncertain prior attempt.
2. Choose a low-traffic window and bounded lock/statement timeouts in the same connection. ALTER TABLE/CHECK changes can take strong locks and scan existing rows, blocking readers/writers until commit. Confirm rollback after any timeout. No business-row rewrite/deletion or existing-price change is intended.
3. Execute **only** the reviewed migration file once, as the approved migration role. It is atomic; new enum comparisons use text and billing insertion occurs after commit. Verify validated CHECKs, five tables/indexes/triggers/RLS, effective server access and API-role DML denial. Confirm ordinary job/checkout reads.
4. Keep the offer BillingPlan absent/inactive. Merge/build compatible jobs and website artifacts under root coordination; automatic Cloudflare builds may run concurrently. Verify both active deployments' source SHAs and ordinary liveness. A banner or successful merge does not certify consumer readiness.
5. Verify PayPal Live mode, credential validity, merchant Orders/capture ability, return origin, required signed webhook events and payment/outbox workers. Binding metadata establishes presence only; secret values were not read. No real payment or paid generation acceptance call was performed.
6. Only after both compatible deployments and merchant prerequisites are confirmed, execute the provision file as its own transaction. It inserts an **active** exact USD1/three-unit/29-image-SKU BillingPlan, so this step opens intake and must be last. A conflicting existing row aborts. A verified capture can still fulfill idempotently if intake later stops.
7. Verify the row and safe owner-scoped offer/state reads without creating/capturing an order or invoking a model. Preserve execution IDs, applied hashes and deployment SHAs. Reconcile established Prisma migration history only through the approved process; none is fabricated here.

## Rollback and retained data

Before intake opens, stop the release and retain the additive schema. A failed DDL transaction rolls back atomically; an uncertain result requires read-only inspection. Do not remove the enum or restore CHECKs speculatively.

After paid facts exist, stop only new checkout intake through an approved exact-row `active=false` change. Retain purchases, units, reservations, adjustments and immutable ledger. Unknown provider outcomes stay held; known late success consumes once and known failure releases/revokes according to grant state. No ordinary-credit grant, history deletion or automatic monetary refund is a rollback step.

Keep compatible consumers/readers until reservations settle, and retain compatible readers for unspent purchases. Do not deploy old consumers, drop tables, remove the enum or restore the positive-credit-only CHECK while pass grants/jobs remain. Prefer a forward corrective migration and reviewed code fix over destructive schema rollback.

No production DDL/provisioning, deployment, real payment or paid generation was executed during package preparation. Isolated PostgreSQL results are review evidence, not a production execution record.
