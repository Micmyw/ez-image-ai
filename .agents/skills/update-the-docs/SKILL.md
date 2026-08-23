---
name: update-the-docs
description: Use when updating in-repository product documentation or preparing an explicit external documentation handoff.
---

# Update the docs

## Scope

Use for the bundled Fumadocs application under `apps/docs` and documentation impact analysis. Do not invent a local path for documentation owned by another repository.

## Procedure

1. Decide ownership before editing:
   - Customer/product docs bundled with this starter belong in `apps/docs/content/docs`.
   - Public supastarter framework documentation linked from `README.md` at `https://supastarter.dev/docs/nextjs` may be owned outside this checkout; record an out-of-repo handoff if the required source is absent.
2. Add or edit `.mdx` under `apps/docs/content/docs`. `apps/docs/source.config.ts` uses Fumadocs' `frontmatterSchema` and `metaSchema`; mirror nearby frontmatter and keep commands, paths, env names, routes, and ports synchronized with current code.
3. Update the nearest `meta.json` `pages` array so Fumadocs navigation exposes a new page. Add a directory `meta.json` for a new section.
4. Link to symbols and paths that exist in this repository. For provider dashboards or external deployment steps, identify the external system and required handoff without fabricating credentials or repository locations.
5. Generate/type-check docs:
   ```bash
   pnpm --filter docs type-check
   pnpm --filter docs build
   ```
   `type-check` runs `next typegen`, `fumadocs-mdx`, and TypeScript.
6. Preview with `pnpm --filter docs dev` when layout, MDX components, or navigation changes.
7. Run `pnpm format`, `pnpm lint`, and `pnpm type-check`.

## Canonical reference

`apps/docs/content/docs/getting-started/overview.mdx` is registered by `apps/docs/content/docs/getting-started/meta.json`; root ordering is in `apps/docs/content/docs/meta.json`.

## Done

Every documented command/path/symbol/env/route resolves in this checkout, new pages are reachable through `meta.json`, docs type-check/build succeeds, and external-source work is an explicit handoff.

## Common mistakes

- Editing generated `apps/docs/.source` output.
- Adding an MDX page without `meta.json` navigation.
- Copying stale commands from another starter kit.
- Claiming the public supastarter docs source exists at an unverified local path.
