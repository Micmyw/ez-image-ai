---
name: update-the-docs
description: Use when updating in-repository product documentation or preparing an explicit external documentation handoff.
---

# Update the docs

## Scope

Use for the Fumadocs content mounted by `apps/saas` below `/docs` and documentation impact
analysis. Do not invent a local path for documentation owned by another repository.

## Procedure

1. Decide ownership before editing:
   - Customer/product docs bundled with this product belong in `apps/saas/content/docs`.
   - Public supastarter framework documentation linked from `README.md` at `https://supastarter.dev/docs/nextjs` may be owned outside this checkout; record an out-of-repo handoff if the required source is absent.
2. Add or edit `.mdx` under `apps/saas/content/docs`. `apps/saas/source.config.ts` uses Fumadocs'
   schemas; mirror nearby frontmatter and keep commands, paths, env names, and `/docs` routes
   synchronized with current code.
3. Update the nearest `meta.json` `pages` array so Fumadocs navigation exposes a new page. Add a directory `meta.json` for a new section.
4. Link to symbols and paths that exist in this repository. For provider dashboards or external deployment steps, identify the external system and required handoff without fabricating credentials or repository locations.
5. Generate/type-check docs:
   ```bash
   pnpm --filter saas generate
   pnpm --filter saas type-check
   pnpm --filter saas build
   ```
   `type-check` runs `next typegen`, `fumadocs-mdx`, and TypeScript.
6. Preview with `pnpm --filter saas dev` when layout, MDX components, or navigation changes.
7. Run focused formatting/linting plus the SaaS type check; use full workspace gates only when the
   change impact requires them.

## Canonical reference

`apps/saas/content/docs/meta.json` owns root ordering, and
`apps/saas/modules/docs/lib/source.ts` owns the `/docs` base URL and namespaced search/LLM/OG URLs.

## Done

Every documented command/path/symbol/env/route resolves in this checkout, new pages are reachable through `meta.json`, docs type-check/build succeeds, and external-source work is an explicit handoff.

## Common mistakes

- Editing generated `apps/saas/.source` output.
- Adding an MDX page without `meta.json` navigation.
- Copying stale commands from another starter kit.
- Claiming the public supastarter docs source exists at an unverified local path.
