# Image-pass production migration review package

Target: Supabase project `ezimageai-production`, reference `cresrmesgalqdgbxtyvm`, PostgreSQL 17. The user authorized this USD1/three-image/PayPal-only release, its necessary bounded migration and normal deployment, and explicitly waived the additional backup and repeated-approval prerequisites on 2026-10-19. Preserve target confirmation, passing code/database compatibility tests, financial invariants and the compatible-consumer order. This authorization does not cover unrelated migrations, destructive reset, credential changes or real paid tests. Execution evidence belongs to the release record; this source package alone is not evidence of production application.

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

Old ordinary-job consumers can continue reading known CREDITS jobs after this schema delta. Old consumers and generated purchase enum readers cannot safely handle new IMAGE_PASS jobs/purchases. Prevent checkout/admission until both website and jobs deployments run compatible code. Before both compatible deployments, the IMAGE_PASS BillingPlan row must be completely ABSENT. An inactive row still exposes a new enum value to old generated readers. Once grants exist, intake state is insufficient as a consumer compatibility gate.

The banner reads server-safe offer availability and remains hidden while the offer row is absent, checks fail, loading continues or a request errors. The purchase page disables checkout and states unavailability. The public response contains no row ID, credentials or internal failure detail. Existing Live binding/mode and route metadata can be verified without reading credentials; real merchant capture remains untested under the user's no-real-payment scope and is not an added approval prerequisite.

## Ordered release procedure

1. Complete independent review and official-client CI, schema-drift/build/type/lifecycle checks. Confirm target and execution role. Read catalog first: new tables/columns/enum must be absent, replaced constraints must match baseline and exact offer row must be absent. Inspect committed state before retrying any uncertain prior attempt. No backup/PITR confirmation or repeated human approval is required by this release.
2. Choose a low-traffic window and bounded lock/statement timeouts in the same connection. ALTER TABLE/CHECK changes can take strong locks and scan existing rows, blocking readers/writers until commit. Confirm rollback after any timeout. No business-row rewrite/deletion or existing-price change is intended.
3. Execute **only** the reviewed migration file once, as the existing migration role. If the exact-main builder runner is needed for official Prisma application/history, merge the tested source first: normal pending-migration builds stop before deployment. Drain those builds, temporarily use the designated website trigger with `pnpm install --frozen-lockfile && pnpm cloudflare:image-pass:migrate --apply --expected-commit <exact-main-SHA>` and a no-op deploy command, then restore and read back its normal commands on success or failure. The named pnpm script supplies the runner's required package-manager environment; do not invoke it through `pnpm exec`. The runner applies bounded atomic DDL, verifies catalog/RLS/access and records the official Prisma receipt. New enum comparisons use text and billing insertion occurs after commit. No manual fabricated receipt or blind rerun is permitted.
4. Keep the offer BillingPlan completely ABSENT; do not insert an inactive placeholder. After migration/history checks, build compatible jobs and website artifacts under root coordination. Verify both active deployments' source SHAs and ordinary liveness. A banner or successful merge does not certify consumer readiness.
5. Verify existing PayPal Live mode/binding presence, return origin, signed-webhook handling and payment/outbox consumer compatibility without reading secret values or making real payment/model calls. Record the remaining live merchant/capture validation boundary; do not introduce a new manual approval, credential setup or expiry gate.
6. Only after both compatible deployments and merchant prerequisites are confirmed, execute the provision file as its own transaction. It inserts an **active** exact USD1/three-unit/29-image-SKU BillingPlan, so this step opens intake and must be last. A conflicting existing row aborts. A verified capture can still fulfill idempotently if intake later stops.
7. Verify the row and safe owner-scoped offer/state reads without creating/capturing an order or invoking a model. Preserve execution IDs, applied hashes and deployment SHAs. Reconcile established Prisma migration history only through the approved process; none is fabricated here.

## Rollback and retained data

Before intake opens, stop the release and retain the additive schema. A failed DDL transaction rolls back atomically; an uncertain result requires read-only inspection. Do not remove the enum or restore CHECKs speculatively.

After paid facts exist, stop only new checkout intake through an approved exact-row `active=false` change. Retain purchases, units, reservations, adjustments and immutable ledger. Unknown provider outcomes stay held; known late success consumes once and known failure releases/revokes according to grant state. No ordinary-credit grant, history deletion or automatic monetary refund is a rollback step.

Keep compatible consumers/readers until reservations settle, and retain compatible readers for unspent purchases. Do not deploy old consumers, drop tables, remove the enum or restore the positive-credit-only CHECK while pass grants/jobs remain. Prefer a forward corrective migration and reviewed code fix over destructive schema rollback.

No production DDL/provisioning, deployment, real payment or paid generation was executed during package preparation. Isolated PostgreSQL results are review evidence, not a production execution record.
