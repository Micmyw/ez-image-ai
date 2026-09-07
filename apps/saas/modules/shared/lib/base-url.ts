import { getBaseUrl as getBaseUrlFromUtils } from "@repo/utils";

const googleVerificationToken = /^[A-Za-z0-9_-]{30,128}$/;

export function parseGoogleSiteVerification(value: string | undefined): string | undefined {
	const candidate = value?.trim();
	if (!candidate || !googleVerificationToken.test(candidate)) return undefined;
	if (/placeholder|replace[-_]?me/i.test(candidate)) return undefined;
	return candidate;
}

export function getBaseUrl() {
	return getBaseUrlFromUtils(process.env.NEXT_PUBLIC_SAAS_URL, 3000);
}
