import { createHmac, timingSafeEqual } from "node:crypto";

export const PROVIDER_ORIGINAL_PREFIX = "provider-original-v1/";
export function isProviderOriginalKey(key: string) {
	return /^provider-original-v1\/users\/[\w-]+\/assets\/[\w-]+\/original\.(jpg|png|webp|gif|svg)$/.test(
		key,
	);
}

function signature(
	key: string,
	expires: number,
	disposition: string,
	secret: string,
	scope = "approved",
) {
	if (secret.length < 32) throw new Error("ORIGINAL_ACCESS_CONFIGURATION_INVALID");
	return createHmac("sha256", secret)
		.update(JSON.stringify(["provider-original-v1", key, expires, disposition, scope]))
		.digest("hex");
}

export function createProviderOriginalReadUrl(
	input: { key: string; expiresIn?: number; responseContentDisposition?: string; scope?: "admin" },
	environment = process.env,
) {
	if (!isProviderOriginalKey(input.key)) throw new Error("ORIGINAL_ACCESS_KEY_INVALID");
	const expires = Date.now() + Math.min(300, Math.max(1, input.expiresIn ?? 300)) * 1_000;
	const disposition = input.responseContentDisposition ?? "inline";
	const scope = input.scope ?? "approved";
	const url = new URL("/api/media/original", environment.NEXT_PUBLIC_SAAS_URL);
	url.search = new URLSearchParams({
		key: input.key,
		expires: String(expires),
		disposition,
		scope,
		signature: signature(
			input.key,
			expires,
			disposition,
			environment.WORKFLOWS_DISPATCH_SECRET ?? "",
			scope,
		),
	}).toString();
	return url.toString();
}

export function verifyProviderOriginalReadUrl(url: URL, environment = process.env) {
	const key = url.searchParams.get("key") ?? "";
	const expires = Number(url.searchParams.get("expires"));
	const disposition = url.searchParams.get("disposition") ?? "";
	const supplied = url.searchParams.get("signature") ?? "";
	const scope = url.searchParams.get("scope") ?? "approved";
	if (
		!isProviderOriginalKey(key) ||
		!Number.isSafeInteger(expires) ||
		expires <= Date.now() ||
		expires > Date.now() + 300_000 ||
		!["approved", "admin"].includes(scope) ||
		!/^(inline|attachment; filename="[\w.-]+")$/.test(disposition) ||
		!/^[a-f0-9]{64}$/.test(supplied)
	)
		return null;
	const expected = signature(
		key,
		expires,
		disposition,
		environment.WORKFLOWS_DISPATCH_SECRET ?? "",
		scope,
	);
	return timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(expected, "hex"))
		? { key, expires, disposition, scope }
		: null;
}
