import { getBaseUrl as getBaseUrlFromUtils } from "@repo/utils";

const googleVerificationToken = /^[A-Za-z0-9_-]{30,128}$/;

export function parseProductionMarketingOrigin(value: string | undefined): string | undefined {
	const candidate = value?.trim();
	if (!candidate) return undefined;
	try {
		const url = new URL(candidate);
		const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
		if (url.username || url.password) return undefined;
		if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
			return undefined;
		}
		if (url.hostname.endsWith(".invalid")) return undefined;
		return url.origin;
	} catch {
		return undefined;
	}
}

export function parseGoogleSiteVerification(value: string | undefined): string | undefined {
	const candidate = value?.trim();
	if (!candidate || !googleVerificationToken.test(candidate)) return undefined;
	if (/placeholder|replace[-_]?me/i.test(candidate)) return undefined;
	return candidate;
}

export function getBaseUrl() {
	const configured = process.env.NEXT_PUBLIC_MARKETING_URL;
	if (configured !== undefined) {
		const origin = parseProductionMarketingOrigin(configured);
		if (!origin) throw new Error("NEXT_PUBLIC_MARKETING_URL must be a real HTTPS marketing origin");
		return origin;
	}
	return getBaseUrlFromUtils(undefined, 3001);
}
