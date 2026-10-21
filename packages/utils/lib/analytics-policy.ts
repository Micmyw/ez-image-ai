/** Shared policy; geography is accepted only from the explicitly configured trusted proxy. */
export const ANALYTICS_CONSENT_VERSION = "2";
const optInCountries = new Set(
	"AT BE BG HR CY CZ DK EE FI FR DE GR HU IS IE IT LV LI LT LU MT NL NO PL PT RO SK SI ES SE GB CH".split(
		" ",
	),
);

export function analyticsCookieValue(cookie: string, name: string): string | undefined {
	return cookie
		.split(";")
		.map((part) => part.trim())
		.find((part) => part.startsWith(`${name}=`))
		?.slice(name.length + 1);
}

export function hasAnalyticsPrivacySignal(headers: Headers): boolean {
	return headers.get("sec-gpc") === "1" || headers.get("dnt") === "1";
}

export function browserAnalyticsPrivacySignal(): boolean {
	return (
		typeof navigator !== "undefined" &&
		((navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true ||
			navigator.doNotTrack === "1")
	);
}

export function resolveAnalyticsPolicy(
	headers: Headers,
	environment: Record<string, string | undefined> = process.env,
) {
	const provider = environment.MEDIA_TRUSTED_PROXY_PROVIDER?.trim().toLowerCase();
	const country = (
		provider === "cloudflare"
			? headers.get("cf-ipcountry")
			: provider === "vercel"
				? headers.get("x-vercel-ip-country")
				: null
	)
		?.trim()
		.toUpperCase();
	// A deliberately narrow, configurable opt-out rollout. Never infer that all non-European
	// jurisdictions allow tracking. Empty configuration requires opt-in everywhere.
	const regionalCountries = new Set(
		(environment.ANALYTICS_OPT_OUT_COUNTRIES ?? "US")
			.toUpperCase()
			.split(",")
			.map((value) => value.trim())
			.filter((value) => /^[A-Z]{2}$/.test(value) && !["XX", "ZZ", "T1"].includes(value)),
	);
	const requiresOptIn = !country || optInCountries.has(country) || !regionalCountries.has(country);
	const cookie = headers.get("cookie") ?? "";
	const choice = analyticsCookieValue(cookie, "consent");
	const explicit =
		choice === "true" &&
		analyticsCookieValue(cookie, "consent_version") === ANALYTICS_CONSENT_VERSION;
	const privacySignal = hasAnalyticsPrivacySignal(headers);
	return {
		requiresOptIn,
		privacySignal,
		analyticsAllowed: !privacySignal && choice !== "false" && (explicit || !requiresOptIn),
	};
}
