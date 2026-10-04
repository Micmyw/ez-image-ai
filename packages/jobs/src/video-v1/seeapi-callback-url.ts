import { readVideoSeeapiCallbackConfig } from "@repo/config/video-seeapi-callback";
import { resolveVideoV1CallbackBaseUrl } from "@repo/config/video-v1";

export interface SeeapiVideoCallbackIdentity {
	assetId: string;
	generation: number;
	attemptNumber: number;
}
type Environment = Record<string, string | undefined>;
const PURPOSE = "ezpic:video-v1:seeapi-moderation-callback:v1";
const PATH = "/api/webhooks/video-v1/seeapi/";

function validIdentity(input: SeeapiVideoCallbackIdentity): boolean {
	return (
		typeof input.assetId === "string" &&
		/^[A-Za-z0-9_-]{1,160}$/.test(input.assetId) &&
		Number.isSafeInteger(input.generation) &&
		input.generation > 0 &&
		Number.isSafeInteger(input.attemptNumber) &&
		input.attemptNumber > 0
	);
}
function message(input: SeeapiVideoCallbackIdentity): Uint8Array<ArrayBuffer> {
	return new Uint8Array(
		new TextEncoder().encode(
			JSON.stringify([PURPOSE, input.assetId, input.generation, input.attemptNumber]),
		),
	);
}
async function key(secret: string, usage: "sign" | "verify") {
	return crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		[usage],
	);
}

/** Private server-to-provider URL: its proof locates one immutable moderation attempt. */
export async function createSeeapiVideoCallbackUrl(
	input: SeeapiVideoCallbackIdentity,
	environment: Environment,
): Promise<string> {
	const config = readVideoSeeapiCallbackConfig(environment);
	const origin = resolveVideoV1CallbackBaseUrl(environment);
	if (!config.ready || !config.callbackSecret || !origin || !validIdentity(input))
		throw new Error("VIDEO_SEEAPI_CALLBACK_NOT_CONFIGURED");
	const proof = Array.from(
		new Uint8Array(
			await crypto.subtle.sign("HMAC", await key(config.callbackSecret, "sign"), message(input)),
		),
	)
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	const url = new URL(`${PATH}${input.assetId}`, origin);
	url.searchParams.set("generation", String(input.generation));
	url.searchParams.set("attempt", String(input.attemptNumber));
	url.searchParams.set("proof", proof);
	return url.toString();
}

export async function verifySeeapiVideoCallbackUrl(
	value: string,
	environment: Environment,
): Promise<SeeapiVideoCallbackIdentity | null> {
	try {
		const config = readVideoSeeapiCallbackConfig(environment);
		const origin = resolveVideoV1CallbackBaseUrl(environment);
		const url = new URL(value);
		if (
			!config.ready ||
			!config.callbackSecret ||
			!origin ||
			url.origin !== origin ||
			url.username ||
			url.password ||
			url.hash ||
			!url.pathname.startsWith(PATH)
		)
			return null;
		const fields = ["generation", "attempt", "proof"];
		if (
			Array.from(url.searchParams.keys()).length !== fields.length ||
			fields.some((field) => url.searchParams.getAll(field).length !== 1)
		)
			return null;
		const generation = url.searchParams.get("generation")!;
		const attempt = url.searchParams.get("attempt")!;
		const proof = url.searchParams.get("proof")!;
		if (
			!/^[1-9]\d{0,15}$/.test(generation) ||
			!/^[1-9]\d{0,15}$/.test(attempt) ||
			!/^[a-f0-9]{64}$/.test(proof)
		)
			return null;
		const input = {
			assetId: url.pathname.slice(PATH.length),
			generation: Number(generation),
			attemptNumber: Number(attempt),
		};
		if (!validIdentity(input)) return null;
		const signature = Uint8Array.from(proof.match(/../g)!, (byte) => Number.parseInt(byte, 16));
		return (await crypto.subtle.verify(
			"HMAC",
			await key(config.callbackSecret, "verify"),
			signature,
			message(input),
		))
			? input
			: null;
	} catch {
		return null;
	}
}
