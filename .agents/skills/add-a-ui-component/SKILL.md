---
name: add-a-ui-component
description: Use when adding a reusable React primitive to the shared Base UI and Tailwind component package.
---

# Add a UI component

## Scope

Use for reusable primitives shared by apps. Do not move feature-specific composites or business logic into `packages/ui`.

## Procedure

1. Search `packages/ui/components` and `@base-ui/react` before creating a duplicate.
2. Add `packages/ui/components/<component>.tsx`. Compose Base UI primitives, merge classes with `cn` from `../lib`, forward refs where consumers need them, and expose typed variants with `class-variance-authority` when appropriate.
3. Add `"use client"` only when the primitive requires event handling, state, effects, or a client-only Base UI primitive.
4. Use Base UI's `render` composition API. Do not introduce Radix `asChild`; when combining two triggers, use `mergeTriggerProps` from `packages/ui/lib/index.ts`.
5. Export the component from `packages/ui/index.ts`. This package has no `exports` map: workspace consumers currently use either direct `@repo/ui/components/<component>` paths or the `@repo/ui` barrel, so verify both the file and barrel import you introduce.
6. Preserve accessibility: semantic element, label/description association, keyboard behavior, focus ring, disabled state, and screen-reader text for icon-only controls.
7. Exercise the primitive in a real app component. If scaffolding helps, run the existing package script and then reconcile output with repository conventions:
   ```bash
   pnpm --filter @repo/ui shadcn-ui
   ```
8. Run `pnpm --filter @repo/ui type-check`, affected tests, `pnpm format`, `pnpm lint`, and `pnpm type-check`.

## Canonical reference

`packages/ui/components/button.tsx` implements variants and a typed `render` prop; `packages/ui/components/dialog.tsx` wraps `@base-ui/react/dialog` with accessible shared styling.

## Done

The direct module and barrel exports resolve, a real app consumer proves composition and keyboard/focus behavior, no app/business dependency leaked into `@repo/ui`, and UI/workspace checks pass.

## Common mistakes

- Copying a Radix component that uses `asChild`.
- Adding feature copy, API calls, or app aliases to `packages/ui`.
- Forgetting the barrel export.
- Creating a client component for static markup.
- Assuming Radix prop names/events match the wrapped Base UI primitive.
