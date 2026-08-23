export function draftClientIdentity(
	headers: Headers,
	environment: Record<string, string | undefined>,
): string {
	const provider = environment.MEDIA_TRUSTED_PROXY_PROVIDER?.trim().toLowerCase();
	const value =
		provider === "vercel"
			? headers.get("x-vercel-forwarded-for")?.split(",")[0]
			: provider === "cloudflare"
				? headers.get("cf-connecting-ip")
				: undefined;
	return normalizeAddress(value) ?? "unattributed";
}

function normalizeAddress(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	if (!trimmed || trimmed.length > 64 || !/^[0-9a-f:.]+$/i.test(trimmed)) return null;
	return trimmed.toLowerCase();
}
