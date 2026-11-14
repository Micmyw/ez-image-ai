import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const production = () => process.env.NODE_ENV === "production";
const cookieName = () => (production() ? "__Host-ezpic_guest" : "ezpic_guest");

function signingSecret(): string {
	const secret = process.env.BETTER_AUTH_SECRET;
	if (!secret || secret.length < 32) throw new Error("GUEST_BROWSER_CONFIGURATION_REQUIRED");
	return secret;
}

function signature(id: string): string {
	return createHmac("sha256", signingSecret()).update(`guest-browser-v1:${id}`).digest("base64url");
}

function browserHash(id: string): string {
	return createHash("sha256").update(`guest-browser-v1:${id}`).digest("hex");
}

export function readGuestBrowserSubject(headers: Headers): string | null {
	const cookies = (headers.get("cookie") ?? "").split(";").map((part) => part.trim());
	const value = cookies
		.find((part) => part.startsWith(`${cookieName()}=`))
		?.slice(cookieName().length + 1);
	if (!value) return null;
	const [id, supplied, extra] = value.split(".");
	if (!id || !supplied || extra || !TOKEN.test(id) || !TOKEN.test(supplied)) return null;
	const expected = signature(id);
	return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied)) ? browserHash(id) : null;
}

/** The identifier is opaque and HttpOnly; resetting browser storage can create a new identity. */
export function ensureGuestBrowserSubject(headers: Headers, responseHeaders?: Headers): string {
	const existing = readGuestBrowserSubject(headers);
	if (existing) return existing;
	if (!responseHeaders) throw new Error("GUEST_BROWSER_COOKIE_REQUIRED");
	const id = randomBytes(32).toString("base64url");
	responseHeaders.append(
		"Set-Cookie",
		`${cookieName()}=${id}.${signature(id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=34560000${production() ? "; Secure" : ""}`,
	);
	return browserHash(id);
}

export function guestUploadIdentity(subjectHash: string, requestId: string) {
	const derive = (purpose: string) =>
		createHmac("sha256", signingSecret())
			.update(`guest-upload-v1:${purpose}:${subjectHash}:${requestId}`)
			.digest("hex");
	return {
		ownerId: `guest_upload_${derive("owner")}`,
		assetId: `asset_${derive("asset").slice(0, 32)}`,
		sessionId: derive("session"),
		objectNonce: derive("object"),
		stagingNonce: derive("staging"),
		completionToken: createHmac("sha256", signingSecret())
			.update(`guest-upload-v1:completion:${subjectHash}:${requestId}`)
			.digest("base64url"),
	};
}
