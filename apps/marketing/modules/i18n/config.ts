import type { Locale } from "@repo/i18n";
import { config as i18nConfig } from "@repo/i18n";

import type { MarketingI18nConfig } from "./types";

export const config: MarketingI18nConfig = i18nConfig;
export type { Locale };

export function getLocaleRobots(locale: string): { index: boolean; follow: boolean } {
	void locale;
	return { index: false, follow: true };
}

const approvedIndexablePaths = new Set(["/", "/pricing", "/privacy", "/terms"]);

export function getApprovedMarketingPageRobots(
	locale: string,
	path: string,
): { index: boolean; follow: boolean } {
	return locale === config.defaultLocale && approvedIndexablePaths.has(path)
		? { index: true, follow: true }
		: { index: false, follow: true };
}
