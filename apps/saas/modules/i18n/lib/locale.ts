import { config as i18nConfig, isLocale, type Locale } from "@repo/i18n";

export function resolveRequestLocale(requestLocale: unknown, cookieLocale: unknown): Locale {
	if (isLocale(requestLocale)) return requestLocale;
	if (isLocale(cookieLocale)) return cookieLocale;
	return i18nConfig.defaultLocale;
}
