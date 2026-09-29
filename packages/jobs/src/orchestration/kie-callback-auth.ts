import { createHmac, timingSafeEqual } from "node:crypto";

function signature(attemptId: string, secret: string): Buffer {
	return createHmac("sha256", secret).update(`kie-completion:v1:${attemptId}`).digest();
}

export function kieCompletionCallbackUrl(
	attemptId: string,
	environment: Record<string, string | undefined> = process.env,
): string | undefined {
	const secret = environment.WORKFLOWS_DISPATCH_SECRET;
	if (!environment.NEXT_PUBLIC_SAAS_URL || !secret || secret.length < 32) return undefined;
	const url = new URL("/api/webhooks/ai/kie", environment.NEXT_PUBLIC_SAAS_URL);
	if (url.protocol !== "https:") return undefined;
	url.searchParams.set("attempt", attemptId);
	url.searchParams.set("token", signature(attemptId, secret).toString("base64url"));
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
	const expected = signature(attemptId, secret);
	return supplied.length === expected.length && timingSafeEqual(supplied, expected)
		? attemptId
		: null;
}
