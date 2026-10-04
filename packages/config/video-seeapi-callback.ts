/** Server-only configuration. Never include this result in public catalog responses. */
export function readVideoSeeapiCallbackConfig(environment: Record<string, string | undefined>): {
	ready: boolean;
	keys: Record<string, string>;
	callbackSecret: string | null;
} {
	const invalid = { ready: false, keys: {}, callbackSecret: null };
	const secret = environment.VIDEO_SEEAPI_CALLBACK_SECRET;
	const encoded = environment.SEEAPI_WEBHOOK_SIGNING_KEYS;
	if (!secret || !/^[\x21-\x7e]{32,512}$/.test(secret) || !encoded || encoded.length > 8192)
		return invalid;
	try {
		const value: unknown = JSON.parse(encoded);
		if (!value || typeof value !== "object" || Array.isArray(value)) return invalid;
		const entries = Object.entries(value);
		if (
			!entries.length ||
			entries.length > 8 ||
			entries.some(
				([key, entry]) =>
					!/^whkey_[A-Za-z0-9_-]{1,128}$/.test(key) ||
					typeof entry !== "string" ||
					!/^whsec_[\x21-\x7e]{16,256}$/.test(entry),
			)
		)
			return invalid;
		return { ready: true, keys: Object.fromEntries(entries), callbackSecret: secret };
	} catch {
		return invalid;
	}
}
