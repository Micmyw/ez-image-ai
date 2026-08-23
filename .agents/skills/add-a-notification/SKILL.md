---
name: add-a-notification
description: Use when adding an in-app or email notification type, preference, producer, or presentation.
---

# Add a notification

## Scope

Use for typed notification events delivered in-app and/or by email. Do not bypass preference checks with direct database inserts or direct mail sends.

## Procedure

1. Add the type to `NotificationType` in `packages/database/prisma/schema.prisma`.
2. Mirror the value in PostgreSQL/MySQL `notificationTypeEnum`, SQLite text-enum arrays for both notification tables, and the `NotificationType` constant in `packages/database/drizzle/schema/index.ts`.
3. Generate and migrate:
   ```bash
   pnpm --filter @repo/database generate
   pnpm --filter @repo/database migrate
   ```
4. Add the value to `NOTIFICATION_TYPES` in `packages/notifications/src/types.ts`, then update `NotificationTypeId` and, if user-configurable, the ordered group in `packages/notifications/src/catalog.ts`.
5. Add `settings.notificationsPage.types.<TYPE>.label` to every `packages/i18n/translations/*/saas.json`. Update the `onToggle` type in `apps/saas/modules/settings/components/NotificationPreferencesForm.tsx` if its explicit union does not yet include the type.
6. Add a producer under `packages/notifications/src` and export it from `src/index.ts`. Call `createNotification({ userId, type, data, link })`; the generic email derives its subject from `data.headline` or `data.title` and optionally renders `data.message`.
7. Trigger the producer only after the underlying transaction succeeds. Keep failures observable with `@repo/logs` when notification delivery must not roll back the primary action.
8. Test preference suppression for `IN_APP` and `EMAIL`, persisted data, locale selection, and relative-link expansion through `resolveNotificationLink`.
9. Run database/API/SaaS tests and repository gates.

## Canonical reference

`packages/notifications/src/welcome.ts` calls `createNotification`, and `packages/auth/auth.ts` triggers `createWelcomeNotification` after user creation while logging delivery failures.

## Done

The enum is synchronized across Prisma, all Drizzle variants, `NOTIFICATION_TYPES`, the catalog, Zod generation, settings UI, and every locale; migration/generation succeed; both query layers still implement the notification contract; channel-preference tests and gates pass.

## Common mistakes

- Editing generated Prisma enum output.
- Adding the enum only to Prisma or only to the settings catalog.
- Updating PostgreSQL but leaving MySQL/SQLite enum arrays stale.
- Calling `insertNotification` directly and skipping channel preferences.
- Adding a settings row without extending the form's explicit type union.
