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
3. Apply the reviewed delta in a transaction to staging, run application and credit invariant
   checks, then repeat through the approved production change process.
4. Only after the target matches the current Prisma schema, baseline this repository migration
   with `prisma migrate resolve --applied 20260813000000_ai_media_foundation`.

The baseline command records history; it does not apply the missing media schema. Never mark the
migration applied before the reviewed delta is successfully installed.
