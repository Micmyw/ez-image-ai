import {
	ANALYTICS_CONSENT_VERSION,
	analyticsCookieValue,
	browserAnalyticsPrivacySignal,
} from "./analytics-policy";

export const EZPIC_ANALYTICS_SESSION_COOKIE = "ezpic_analytics_session";
export const EZPIC_CONTENT_ATTRIBUTION_STORAGE_KEY = "ezpic:content-attribution:v1";

export function hasGrowthAnalyticsConsent(cookie: string): boolean {
	const choice = analyticsCookieValue(cookie, "consent");
	return (
		!browserAnalyticsPrivacySignal() &&
		analyticsCookieValue(cookie, "consent_version") === ANALYTICS_CONSENT_VERSION &&
		(choice === "true" || choice === "regional")
	);
}

export function readGrowthAnalyticsSessionHash(cookie: string): string | undefined {
	for (const part of cookie.split(";")) {
		const [name, ...valueParts] = part.trim().split("=");
		if (name !== EZPIC_ANALYTICS_SESSION_COOKIE) continue;
		let value: string;
		try {
			value = decodeURIComponent(valueParts.join("="));
		} catch {
			return undefined;
		}
		if (/^sha256:[a-f0-9]{64}$/.test(value)) return value;
	}
	return undefined;
}
