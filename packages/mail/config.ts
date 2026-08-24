import { getPublicConfig } from "@repo/config/client";
import { config as i18nConfig } from "@repo/i18n";

import type { MailConfig } from "./types";

const publicProductConfig = getPublicConfig();

export const config = {
	appName: process.env.NEXT_PUBLIC_SITE_NAME?.trim() || publicProductConfig.brand.siteName,
	mailFrom: process.env.MAIL_FROM as string,
	locales: Object.keys(i18nConfig.locales) as (keyof typeof i18nConfig.locales)[],
	defaultLocale: i18nConfig.defaultLocale,
} satisfies MailConfig;

export type Locale = keyof typeof i18nConfig.locales;
