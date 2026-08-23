import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const DRAFT_CLAIM_COOKIE = "media_draft_claim";

export function createDraftClaimToken(): string {
	return randomBytes(32).toString("base64url");
}

export function hashDraftClaimToken(token: string): string {
	return createHash("sha256").update(token, "utf8").digest("hex");
}

export function draftTokenHashesMatch(token: string, expectedHash: string): boolean {
	const actual = Buffer.from(hashDraftClaimToken(token), "hex");
	const expected = Buffer.from(expectedHash, "hex");
	return expected.length === actual.length && timingSafeEqual(actual, expected);
}

export function assertMarketingOrigin(origin: string | null, configuredOrigin: string): void {
	let actual: URL;
	let expected: URL;
	try {
		if (!origin) throw new Error("missing");
		actual = new URL(origin);
		expected = new URL(configuredOrigin);
	} catch {
		throw new Error("FORBIDDEN_ORIGIN");
	}
	if (actual.origin !== expected.origin || origin !== actual.origin) {
		throw new Error("FORBIDDEN_ORIGIN");
	}
}

export function getDraftClaimCookie(token: string, secure: boolean): string {
	return [
		`${DRAFT_CLAIM_COOKIE}=${encodeURIComponent(token)}`,
		"HttpOnly",
		"SameSite=Lax",
		secure ? "Secure" : "",
		"Path=/draft/continue",
		"Max-Age=3600",
	]
		.filter(Boolean)
		.join("; ");
}

export function getExpiredDraftClaimCookie(secure: boolean): string {
	return getDraftClaimCookie("", secure).replace("Max-Age=3600", "Max-Age=0");
}
