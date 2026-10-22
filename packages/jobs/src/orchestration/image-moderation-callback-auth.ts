import { createHmac, timingSafeEqual } from "node:crypto";

import { readVideoSeeapiCallbackConfig } from "@repo/config/video-seeapi-callback";

export interface ImageModerationCallbackIdentity {
	assetId: string;
	generation: number;
	submissionToken: string;
}
const PATH = "/api/webhooks/moderation/seeapi-image";
type Environment = Record<string, string | undefined>;

export function imageModerationCallbackConfig(environment: Environment) {
	// Reuse the bounded signing-key parser; purpose-separated image proofs use
	// the existing website/jobs shared secret, not a new deployment credential.
	return readVideoSeeapiCallbackConfig({
		...environment,
		VIDEO_SEEAPI_CALLBACK_SECRET: environment.WORKFLOWS_DISPATCH_SECRET,
	});
}
function valid(input: ImageModerationCallbackIdentity) {
	return (
		/^[A-Za-z0-9_-]{1,160}$/.test(input.assetId) &&
		Number.isSafeInteger(input.generation) &&
		input.generation > 0 &&
		/^[A-Za-z0-9_-]{1,160}$/.test(input.submissionToken)
	);
}
function signature(input: ImageModerationCallbackIdentity, secret: string) {
	return createHmac("sha256", secret)
		.update(
			JSON.stringify([
				"ezpic:image-moderation-callback:v1",
				input.assetId,
				input.generation,
				input.submissionToken,
			]),
		)
		.digest();
}
function origin(environment: Environment): string | null {
	try {
		const url = new URL(environment.NEXT_PUBLIC_SAAS_URL ?? "");
		return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
			? url.origin
			: null;
	} catch {
		return null;
	}
}
export function imageModerationCallbackUrl(
	input: ImageModerationCallbackIdentity,
	environment: Environment,
): string | undefined {
	const config = imageModerationCallbackConfig(environment);
	const base = origin(environment);
	if (!config.ready || !config.callbackSecret || !base || !valid(input)) return undefined;
	const url = new URL(PATH, base);
	url.searchParams.set("asset", input.assetId);
	url.searchParams.set("generation", String(input.generation));
	url.searchParams.set("submission", input.submissionToken);
	url.searchParams.set("token", signature(input, config.callbackSecret).toString("base64url"));
	return url.toString();
}
export function verifyImageModerationCallbackUrl(
	value: string,
	environment: Environment,
): ImageModerationCallbackIdentity | null {
	try {
		const config = imageModerationCallbackConfig(environment);
		const url = new URL(value);
		const fields = ["asset", "generation", "submission", "token"];
		if (
			!config.ready ||
			!config.callbackSecret ||
			url.origin !== origin(environment) ||
			url.pathname !== PATH ||
			url.username ||
			url.password ||
			url.hash ||
			Array.from(url.searchParams.keys()).length !== fields.length ||
			fields.some((name) => url.searchParams.getAll(name).length !== 1)
		)
			return null;
		const generation = url.searchParams.get("generation")!;
		const token = url.searchParams.get("token")!;
		const input = {
			assetId: url.searchParams.get("asset")!,
			generation: Number(generation),
			submissionToken: url.searchParams.get("submission")!,
		};
		if (!/^[1-9]\d{0,15}$/.test(generation) || !/^[\w-]{43}$/.test(token) || !valid(input))
			return null;
		const expected = signature(input, config.callbackSecret);
		const supplied = Buffer.from(token, "base64url");
		return expected.length === supplied.length && timingSafeEqual(expected, supplied)
			? input
			: null;
	} catch {
		return null;
	}
}
