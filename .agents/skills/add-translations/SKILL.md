---
name: add-translations
description: "Use when adding locale keys or locales, translating app/mail content, or fixing missing-translation errors."
---

# Add translations

## Scope

Use for application and mail UI strings. Do not translate database identifiers, provider values, logs, or protocol error codes.

## Procedure

1. Choose the scope:
   - `shared.json` for cross-package messages
   - `saas.json` for public, authenticated, and auth UI
   - `mail.json` for email templates
2. Add the same nested key and compatible interpolation/plural shape to every locale under `packages/i18n/translations/{en,de,es,fr}`. `getMessagesForLocale` in `packages/i18n/lib/get-messages.ts` merges `shared.json` into app scopes and falls back to English, but fallback is not a reason to omit translations.
3. In client components, call `useTranslations()` or `useTranslations("...")`. SaaS Server
   Components normally call `getTranslations("namespace")` because
   `apps/saas/modules/i18n/request.ts` supplies the locale-cookie selection.
4. Public SaaS routes use unprefixed same-origin paths; do not add a generic root locale segment
   because it conflicts with organization slugs.
5. For email, use `createTranslator` with the template namespace and keep a `subject` key. `packages/mail/lib/i18n.ts` wraps `@repo/i18n`; `packages/mail/lib/templates.ts` consumes that helper.
6. To add a locale, update `packages/i18n/config.ts`, add the active shared, SaaS, and mail JSON files, verify locale cookies/routing, and add localized content variants where required.
7. Remember that English JSON drives the active shared, SaaS, and mail message types. Type-check
   catches invalid keys in code, but it does not prove `de`, `es`, and `fr` parity.
8. Compare leaf keys and interpolation/plural shape across all four locales in the affected scope. Render changed messages in the default and one non-default locale. For a reusable parity example, read [references/locale-parity.md](references/locale-parity.md).
9. Run affected app/mail type checks and formatting/lint checks.

## Canonical reference

`apps/saas/app/(public)/contact/page.tsx` uses the SaaS request locale, while
`apps/saas/modules/settings/components/NotificationPreferencesForm.tsx` uses a client namespace.

## Done

All four locale files in the affected scope have structurally compatible keys, interpolation/plurals render in at least the default and one non-default locale, the app-appropriate server/client API is used, and affected checks pass.

## Common mistakes

- Adding a key only to `en`.
- Mixing mail strings into `saas.json`.
- Adding locale prefixes that collide with organization slugs.
- Passing one namespace's key shape to another locale file.
- Using a removed split-application locale pattern instead of the SaaS locale cookie.
