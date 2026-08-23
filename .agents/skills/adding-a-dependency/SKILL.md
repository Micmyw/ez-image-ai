---
name: adding-a-dependency
description: Use when introducing or relocating an npm dependency in a pnpm workspace package.
---

# Add a dependency

## Scope

Use only when existing workspace code cannot satisfy the requirement. Do not add a package for a small helper already available in the platform, an existing dependency, or `@repo/*` workspace code.

## Procedure

1. Identify the package that imports the dependency and its exact package name from `package.json` (`saas`, `marketing`, `@repo/api`, and so on).
2. Search the singular `catalog:` map in `pnpm-workspace.yaml` and workspace manifests for current use. Reuse `catalog:` for shared external packages and `workspace:*` for `@repo/*`.
3. Add the latest suitable release with pnpm to the importing workspace:
   ```bash
   pnpm --filter <workspace-name> add <package>
   pnpm --filter <workspace-name> add -D <package>
   ```
   For an internal package use, for example:
   ```bash
   pnpm --filter saas add @repo/storage@workspace:*
   ```
4. If the dependency is shared across workspaces, add its resolved range once to `pnpm-workspace.yaml` and use `"catalog:"` in each consumer manifest. Keep `minimumReleaseAge: 1440`; if the latest release is younger than 24 hours, use the latest eligible version rather than disabling the guard.
5. Inspect `package.json` and `pnpm-lock.yaml`; reject unexpected transitive changes, duplicate major versions, install scripts, or packages added to the repository root without a root import.
6. Run focused tests, then:
   ```bash
   pnpm format
   pnpm lint
   pnpm type-check
   ```

## Canonical reference

`apps/saas/package.json` uses `workspace:*` for `@repo/*` packages and `catalog:` for shared dependencies such as `next`; `packages/ui/package.json` keeps UI-only dependencies local.

## Done

The importing workspace alone owns the import, shared versions have one catalog entry, the lockfile contains only expected resolution changes, the release-age policy remains intact, and focused tests plus required gates pass.

## Common mistakes

- Editing only `package.json` instead of using pnpm.
- Adding application-only packages to the root manifest.
- Inventing a version or bypassing `minimumReleaseAge`.
- Adding both a direct version and a `catalog:` entry for the same shared package.
- Hand-editing the lockfile or catalog indentation instead of letting pnpm/Oxfmt normalize it.
