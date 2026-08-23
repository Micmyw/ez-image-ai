---
name: add-translations
description: Use when adding locale keys or supported locales, localizing app/mail content, or fixing a missing-translation type or runtime warning.
---

# Add translations

## Scope

Use for application and mail UI strings. Do not translate database identifiers, provider values, logs, or protocol error codes.

## Procedure

1. Choose the scope:
   - `shared.json` for cross-app messages
   - `saas.json` for authenticated/auth UI
   - `marketing.json` for the public site
   - `mail.json` for email templates
2. Add the same nested key and compatible interpolation/plural shape to every locale under `packages/i18n/translations/{en,de,es,fr}`. `getMessagesForLocale` in `packages/i18n/lib/get-messages.ts` merges `shared.json` into app scopes and falls back to English, but fallback is not a reason to omit translations.
3. In client components, call `useTranslations()` or `useTranslations("...")`. SaaS Server Components normally call `getTranslations("namespace")` because `apps/saas/modules/i18n/request.ts` supplies request locale. Marketing `[locale]` routes pass `getTranslations({ locale, namespace })`.
4. For marketing routes, await `params`, call `setRequestLocale(locale)`, and use `LocaleLink`, `localeRedirect`, `useLocalePathname`, or `useLocaleRouter` from `apps/marketing/modules/i18n/routing.ts`.
5. For email, use `createTranslator` with the template namespace and keep a `subject` key. `packages/mail/lib/i18n.ts` wraps `@repo/i18n`; `packages/mail/lib/templates.ts` consumes that helper.
6. To add a locale, update `packages/i18n/config.ts`, add all four JSON files, verify locale cookies/routing, and add localized content variants where required.
7. Remember that English JSON drives `SharedMessages`, `SaasMessages`, `MarketingMessages`, and `MailMessages` in `packages/i18n/types.ts`, wired into each app's `intl.d.ts`. Type-check catches invalid keys in code, but it does not prove `de`, `es`, and `fr` parity.
8. Check every locale/scope for missing leaf keys:

   ```bash
   node --input-type=module <<'NODE'
   import { readFile } from "node:fs/promises";

   const locales = ["en", "de", "es", "fr"];
   const scopes = ["shared", "saas", "marketing", "mail"];
   const flattenKeys = (value, prefix = "") =>
     Object.entries(value).flatMap(([key, child]) => {
       const path = prefix ? `${prefix}.${key}` : key;
       return child && typeof child === "object" ? flattenKeys(child, path) : [path];
     });
   const missingKeys = [];

   for (const scope of scopes) {
     const english = JSON.parse(
       await readFile(`packages/i18n/translations/en/${scope}.json`, "utf8"),
     );
     const expectedKeys = flattenKeys(english);
     for (const locale of locales.slice(1)) {
       const translated = JSON.parse(
         await readFile(`packages/i18n/translations/${locale}/${scope}.json`, "utf8"),
       );
       const translatedKeys = new Set(flattenKeys(translated));
       for (const key of expectedKeys) {
         if (!translatedKeys.has(key)) missingKeys.push(`${locale}/${scope}: ${key}`);
       }
     }
   }

   if (missingKeys.length) {
     console.error(missingKeys.join("\n"));
     process.exitCode = 1;
   }
   NODE
   ```

9. Run affected app/mail type checks and:
   ```bash
   pnpm format
   pnpm lint
   pnpm type-check
   ```

## Canonical reference

`apps/marketing/app/[locale]/contact/page.tsx` uses server translations and `setRequestLocale`; `apps/saas/modules/settings/components/NotificationPreferencesForm.tsx` uses a client namespace.

## Done

All four locale files in the affected scope have structurally compatible keys, interpolation/plurals render in at least the default and one non-default locale, the app-appropriate server/client API is used, and gates pass.

## Common mistakes

- Adding a key only to `en`.
- Mixing mail strings into `saas.json`.
- Hard-coding locale-aware links with `next/link` in marketing content.
- Passing one namespace's key shape to another locale file.
- Using the marketing `{ locale, namespace }` pattern blindly in SaaS or omitting explicit locale in a marketing route.
