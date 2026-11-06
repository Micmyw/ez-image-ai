import { readVideoSeeapiCallbackConfig } from "@repo/config/video-seeapi-callback";
import { resolveVideoV1CallbackBaseUrl } from "@repo/config/video-v1";

export function newSourceCallbackToken() {
	return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}
export async function sourceCallbackTokenHash(token: string) {
	return Array.from(
		new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))),
		(byte) => byte.toString(16).padStart(2, "0"),
	).join("");
}
export function createSourceTemplateCallbackUrl(
	input: { provider: "kie" | "seeapi"; token: string; input?: { jobId: string; role: string } },
	environment: Record<string, string | undefined>,
) {
	const origin = resolveVideoV1CallbackBaseUrl(environment);
	if (
		!origin ||
		!/^[a-f0-9]{64}$/.test(input.token) ||
		(input.provider === "seeapi" && !readVideoSeeapiCallbackConfig(environment).ready) ||
		(input.input &&
			(input.provider !== "seeapi" ||
				!/^[A-Za-z0-9_-]{1,160}$/.test(input.input.jobId) ||
				!/^[A-Za-z0-9_-]{1,80}$/.test(input.input.role)))
	)
		throw new Error("SOURCE_CALLBACK_NOT_CONFIGURED");
	// The random attempt capability is stored only as a hash. Kie H3 uses the source
	// URL-capability contract; SeeAPI additionally verifies its documented raw-body HMAC.
	const path = input.input
		? `/api/webhooks/video-source-input/${input.input.jobId}/${input.input.role}/${input.token}`
		: `/api/webhooks/video-source/${input.provider}/${input.token}`;
	return new URL(path, origin).href;
}
