---
name: add-or-edit-an-email
description: Use when adding or changing a localized React Email template or transactional send call.
---

# Add or edit an email

## Scope

Use for transactional templates, provider-neutral send calls, and mail translations. Do not send directly through Resend or another provider from feature code.

## Procedure

1. Add or edit a React Email component in `packages/mail/emails`. Accept feature context plus `BaseMailProps`, and use shared `Wrapper` and `PrimaryButton` components.
2. Register a new template key in `packages/mail/emails/index.ts`; that exact key becomes both the typed `TemplateId` and the translation namespace used to resolve `subject`.
3. Add that namespace, including `subject`, to every `packages/i18n/translations/{en,de,es,fr}/mail.json`. Use `createTranslator` from `use-intl/core` in the component instead of hard-coded template copy.
4. Add realistic static `PreviewProps` with `defaultLocale` and `defaultTranslations`, following `packages/mail/emails/Notification.tsx`.
5. Send through `sendEmail` from `@repo/mail`:
   ```ts
   await sendEmail({
     to,
     templateId: "templateKey",
     locale,
     context: { ... },
   });
   ```
6. Preserve locale resolution in auth and notification call sites. Do not pass `locale` or `translations` inside `context`; `getTemplate` supplies them.
7. Preview locally:
   ```bash
   pnpm --filter mail-preview dev
   ```
   Verify HTML, plain-text rendering, subject, links, and long/localized content.
8. Run `pnpm format`, `pnpm lint`, and `pnpm type-check`.

## Canonical reference

`packages/mail/emails/OrganizationInvitation.tsx` is a localized action email; `packages/auth/auth.ts` sends it with `templateId: "organizationInvitation"` and request-derived locale.

## Done

The key resolves to a component and same-named translation namespace, all four locales include compatible messages/subject, HTML and plain text preview correctly, links use real base URLs, the call site handles `sendEmail`'s boolean result as needed, and gates pass.

## Common mistakes

- Calling the active Resend provider directly.
- Adding only English translations or omitting `subject`.
- Putting secrets or runtime-only data in `PreviewProps`.
- Forgetting that provider selection is centralized in `packages/mail/provider/index.ts`.
- Renaming a template key without renaming its `mail.json` namespace and call sites.
