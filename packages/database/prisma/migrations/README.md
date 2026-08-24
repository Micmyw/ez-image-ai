# Prisma migration operations

Prisma is the only supported ORM migration path for the AI media domain. The first committed
migration is a complete initial schema because this repository previously had no migration
history.

## Empty database

Only a confirmed empty database may run the normal deployment workflow:

```powershell
$env:DATABASE_URL = "postgresql://.../confirmed_empty_database"
pnpm --filter @repo/database exec prisma migrate deploy
```

Inspect the target first. `migrate deploy` must not be pointed at an existing Supastarter
deployment because the initial migration also creates the pre-existing auth, organization,
purchase, and notification tables.

## Existing deployment baseline

Never run the complete initial migration blindly on an existing deployment. Use a backup and a
staging copy, then:

1. Generate SQL from the actual existing database to `prisma/schema.prisma` with `prisma migrate
diff --from-config-datasource --to-schema prisma/schema.prisma --script`.
2. Review that deployment-specific delta. It should add the media domain and compatibility bridge
   without recreating or dropping populated Supastarter tables.
3. Separately review the raw SQL after the generated Prisma portion of
   `20260813000000_ai_media_foundation/migration.sql`. Prisma diff does not fully model those
   invariants. The deployment-specific delta must also install every missing named CHECK,
   required index, the `prevent_credit_ledger_mutation()` function, and the
   `credit_ledger_entry_immutable` trigger; never assume a clean Prisma diff installed them.
4. Apply the reviewed delta in a transaction to staging, run application and credit invariant
   checks, then compare `pg_constraint`, `pg_trigger`, and `pg_indexes` with the committed initial
   migration. At minimum, explicitly prove the credit account/lot/reservation/allocation/ledger
   CHECK constraints are validated and the immutable-ledger trigger exists and is enabled.
5. Repeat the reviewed change and catalog verification through the approved production process.
   Only after both the Prisma schema and raw SQL invariants match may you baseline with
   `prisma migrate resolve --applied 20260813000000_ai_media_foundation`.

The baseline command records history; it does not apply the missing media schema, raw CHECKs,
indexes, functions, or triggers. Never mark the migration applied before the reviewed delta is
successfully installed and the catalog verification passes. A missing or disabled raw invariant
is a release blocker, even when Prisma reports no schema drift.

## Immutable upload rollout

Before applying `20260823014000_immutable_upload_promotion`, deploy and drain to a jobs-worker
build that understands `MEDIA_UPLOAD_CLEANUP` and `MEDIA_ASSET_LEGACY_REVERIFY`. These event types
intentionally fail closed on older workers so an old dispatcher cannot silently drop the cleanup
reservation, extra object keys, or legacy re-verification authorization.

Run `20260823014000_immutable_upload_promotion` and
`20260823014100_upload_finalization_leases` in an API maintenance/drain window: remove old API pods
from traffic and wait for their in-flight upload-finalization requests to finish before applying the
migrations, then deploy the new API producers before resuming traffic. The lease trigger provides a
bounded compatibility fence, but cannot stop an already-running old request from performing storage
I/O before its database transition. Monitor the outbox for either event type until all
migration-generated cleanup and re-verification events are processed.

## Raw invariants in later migrations

The AI-media domain remains Prisma-only, but Prisma's schema model still cannot represent every
PostgreSQL invariant added by later migrations. After applying or baselining through
`20260823018000_stripe_refund_repair_authority`, compare the committed SQL with the live catalog and
verify at least the following in addition to the initial ledger checks:

- `purchase_exactly_one_owner` exists. It intentionally remains `NOT VALID` until the documented
  historical ownership audit and repair is complete; new writes are still protected.
- `credit_lot_amounts_valid` includes `expiredUnrefundedAmount` in its conservation bound.
- `stripe_refund_amounts_nonnegative` and `stripe_refund_finalization_requires_success` are valid;
  nonzero finalized credits require a succeeded refund and a finalization timestamp, and no
  non-succeeded refund may carry that timestamp.
- `stripe_reconciliation_running_sweep_complete` and
  `stripe_reconciliation_issue_occurrences_positive` are valid.
- `stripe_reconciliation_continuation_sequence_nonnegative` is valid and the checkpoint's
  `continuationSequence` column is non-null with default zero.
- `payment_event_provider_normalizedTransactionId_idx` is a non-unique lookup index, and the legacy
  normalized-transaction unique indexes are absent. Stripe event receipt deduplication is owned by
  `(provider, providerEventId)`.
- `stripe_refund_repair_authority_credits_positive`,
  `stripe_refund_repair_authority_reason_present`,
  `stripe_refund_repair_authority_action_matches_status`,
  `stripe_refund_repair_receipt_reason_present`, and
  `stripe_refund_repair_receipt_credits_nonnegative` are valid.
- The refund/issue/authority foreign keys use `ON DELETE RESTRICT`; the short unique index
  `stripe_refund_repair_authority_refund_snapshot_key` covers refund ID, lifecycle change ID, and
  ledger fingerprint without PostgreSQL identifier truncation drift. This permits a new approval
  only after an unapplied authority's exact charge snapshot becomes stale.
- `stripe_refund_repair_authority_immutable` and `stripe_refund_repair_receipt_immutable` exist and
  are enabled. Their trigger functions must reject both update and delete; authority and receipt
  history is not repaired by disabling these triggers.

Run the catalog checks against an empty migrated database and a restored staging copy. A successful
`prisma migrate diff` is necessary but does not replace these checks, and an unresolved historical
Purchase owner row blocks `VALIDATE CONSTRAINT purchase_exactly_one_owner` rather than authorizing a
constraint drop.
