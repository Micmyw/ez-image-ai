import type { FirstTouchAttribution } from "./acquisition-attribution";

export const ATTRIBUTION_COOKIE_NAME = "ezimage_first_touch";
export const FIRST_TOUCH_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export function firstTouchCookie(value: FirstTouchAttribution, protocol: string): string {
	return `${ATTRIBUTION_COOKIE_NAME}=${encodeURIComponent(JSON.stringify(value))}; Path=/; Max-Age=${FIRST_TOUCH_MAX_AGE_SECONDS}; SameSite=Lax${protocol === "https:" ? "; Secure" : ""}`;
}

export interface CapturedCheckoutTrigger {
	path: string | null;
	capturedAt: number;
	pricingIntermediary: boolean;
}

/** Capture the actual click synchronously, before navigation or an optional module loads. */
export function collectCheckoutTrigger(value: string, now = new Date()): CapturedCheckoutTrigger {
	try {
		const url = new URL(value);
		const path = sanitizeAttributionPath(value, url.origin);
		return {
			path,
			capturedAt: now.getTime(),
			pricingIntermediary:
				path === "/pricing" || path === "/choose-plan" || url.hash === "#pricing",
		};
	} catch {
		return { path: null, capturedAt: now.getTime(), pricingIntermediary: false };
	}
}

const fixedPaths = new Set([
	"/",
	"/pricing",
	"/choose-plan",
	"/create",
	"/try",
	"/image-to-image",
	"/photo-to-coloring-page",
	"/models",
	"/blog",
	"/docs",
	"/examples",
	"/contact",
	"/privacy",
	"/terms",
	"/changelog",
	"/login",
	"/signup",
	"/dashboard",
	"/assets",
	"/history",
	"/edits",
	"/video",
	"/video/history",
	"/settings/billing",
	"/settings/members",
	"/settings/general",
	"/settings/security",
	"/settings/notifications",
	"/video-effects/hotel-lobby-ai",
	"/video/effects/rumpelstiltskin",
]);
const sensitiveToken =
	/(?:token|secret|password|authorization|session|credential|email|code)[_.-]?[:=]|^[a-f0-9]{24,}$|^\d{16,}$/i;

/** Store only known route shapes. Private resource IDs and organization slugs never persist. */
export function sanitizeAttributionPath(value: string, origin: string): string | null {
	if (
		!value ||
		value.length > 2048 ||
		value.includes("\\") ||
		Array.from(value).some((character) => character.charCodeAt(0) <= 32)
	)
		return null;
	try {
		const base = new URL(origin);
		const url = new URL(value, base);
		if (
			!["http:", "https:"].includes(url.protocol) ||
			url.origin !== base.origin ||
			url.username ||
			url.password
		)
			return null;
		const path = url.pathname.replace(/\/$/, "") || "/";
		if (path.includes("%") || path.length > 256) return null;
		if (fixedPaths.has(path)) return path;
		if (/^\/(?:edits|history)\/[^/]+$/.test(path))
			return path.startsWith("/edits/") ? "/edits" : "/history";
		if (/^\/[a-z0-9-]+\/settings\/(?:billing|general|members)$/.test(path))
			return `/settings/${path.split("/").at(-1)}`;
		if (/^\/(?:blog|docs|models)(?:\/[a-z0-9][a-z0-9-]{0,79}){1,4}$/.test(path)) {
			const segments = path.split("/").slice(2);
			if (
				segments.every(
					(segment) =>
						!sensitiveToken.test(segment) &&
						!/^(?:token|secret|password|auth|callback|session|email|code)$/i.test(segment),
				)
			)
				return path;
		}
		return null;
	} catch {
		return null;
	}
}

function utmToken(value: unknown): string | null {
	if (
		typeof value !== "string" ||
		!/^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(value) ||
		sensitiveToken.test(value)
	)
		return null;
	if (/^(?:token|secret|password|authorization|credential|email)[_.-]/i.test(value)) return null;
	return value;
}
function externalOrigin(value: unknown, origin: string): string | null {
	if (typeof value !== "string" || value.length > 512) return null;
	try {
		const url = new URL(value);
		if (
			!["http:", "https:"].includes(url.protocol) ||
			url.username ||
			url.password ||
			url.origin === new URL(origin).origin
		)
			return null;
		return url.origin;
	} catch {
		return null;
	}
}
export function cleanFirstTouch(
	value: FirstTouchAttribution,
	origin: string,
): FirstTouchAttribution {
	const landingPath = value.landingPath ? sanitizeAttributionPath(value.landingPath, origin) : null;
	const referrerOrigin = externalOrigin(value.referrerOrigin, origin);
	const utmSource = utmToken(value.utmSource);
	const utmMedium = utmToken(value.utmMedium);
	const utmCampaign = utmToken(value.utmCampaign);
	return {
		version: 1,
		landingPath,
		referrerOrigin,
		utmSource,
		utmMedium,
		utmCampaign,
		source:
			utmSource || utmMedium || utmCampaign
				? "campaign"
				: referrerOrigin
					? "referral"
					: landingPath
						? "direct"
						: "unknown",
		capturedAt: value.capturedAt,
	};
}
export function collectFirstTouchAttribution(
	value: string,
	referrer: string,
	now = new Date(),
): FirstTouchAttribution {
	try {
		const url = new URL(value);
		return cleanFirstTouch(
			{
				version: 1,
				landingPath: sanitizeAttributionPath(value, url.origin),
				referrerOrigin: externalOrigin(referrer, url.origin),
				source: "unknown",
				utmSource: url.searchParams.get("utm_source"),
				utmMedium: url.searchParams.get("utm_medium"),
				utmCampaign: url.searchParams.get("utm_campaign"),
				capturedAt: now.toISOString(),
			},
			url.origin,
		);
	} catch {
		return {
			version: 1,
			landingPath: null,
			referrerOrigin: null,
			source: "unknown",
			utmSource: null,
			utmMedium: null,
			utmCampaign: null,
			capturedAt: now.toISOString(),
		};
	}
}
