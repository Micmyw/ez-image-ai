import { createHmac, timingSafeEqual } from "node:crypto";

import { imageResultContextSchema, type ImageResultContext } from "@repo/config/image-result";

function signature(attemptId: string, secret: string): Buffer {
	return createHmac("sha256", secret).update(`kie-completion:v1:${attemptId}`).digest();
}

export function kieCompletionCallbackUrl(
	attemptId: string,
	environment: Record<string, string | undefined> = process.env,
	context?: ImageResultContext,
): string | undefined {
	const secret = environment.WORKFLOWS_DISPATCH_SECRET;
	if (!environment.NEXT_PUBLIC_SAAS_URL || !secret || secret.length < 32) return undefined;
	const url = new URL("/api/webhooks/ai/kie", environment.NEXT_PUBLIC_SAAS_URL);
	if (url.protocol !== "https:") return undefined;
	url.searchParams.set("attempt", attemptId);
	if (context) {
		const parsed = imageResultContextSchema.parse(context);
		if (parsed.attemptId !== attemptId) throw new Error("CALLBACK_CONTEXT_MISMATCH");
		const encoded = Buffer.from(JSON.stringify(parsed)).toString("base64url");
		url.searchParams.set("context", encoded);
		url.searchParams.set(
			"token",
			contextSignature(attemptId, encoded, secret).toString("base64url"),
		);
	} else url.searchParams.set("token", signature(attemptId, secret).toString("base64url"));
	return url.toString();
}

export function verifyKieCompletionCallback(url: URL, secret: string | undefined): string | null {
	const attemptId = url.searchParams.get("attempt");
	const token = url.searchParams.get("token");
	if (
		!secret ||
		secret.length < 32 ||
		!attemptId ||
		!/^[\w-]{1,128}$/.test(attemptId) ||
		!token ||
		!/^[\w-]{43}$/.test(token)
	)
		return null;
	const supplied = Buffer.from(token, "base64url");
	const encoded = url.searchParams.get("context");
	if (encoded && encoded.length > 2048) return null;
	const expected = encoded
		? contextSignature(attemptId, encoded, secret)
		: signature(attemptId, secret);
	return supplied.length === expected.length && timingSafeEqual(supplied, expected)
		? attemptId
		: null;
}

function contextSignature(attemptId: string, context: string, secret: string) {
	return createHmac("sha256", secret).update(`kie-completion:v2:${attemptId}:${context}`).digest();
}

export function readKieImageResultContext(
	url: URL,
	secret: string | undefined,
): ImageResultContext | null {
	const attemptId = verifyKieCompletionCallback(url, secret);
	const encoded = url.searchParams.get("context");
	if (!attemptId || !encoded) return null;
	try {
		const context = imageResultContextSchema.parse(
			JSON.parse(Buffer.from(encoded, "base64url").toString()),
		);
		return context.attemptId === attemptId && context.expiresAt > Date.now() ? context : null;
	} catch {
		return null;
	}
}
