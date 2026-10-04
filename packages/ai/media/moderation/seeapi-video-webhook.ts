/**
 * Generic SeeAPI signature contract, from its publicly served Developer Center example:
 * https://www.seeapi.com/_next/static/immutable/chunks/40t71rwpea69l.js
 * Snapshot SHA-256 e9183bb3ea667edf30e83aaba041f3593b9612d0aa4783c479b5a0ee65d3a23d.
 * This verifies bytes only; it does not assert an inference event/payload schema.
 * Real inference signature compatibility still requires external acceptance.
 * The caller bounds the body, persists replay protection, and maps the task-bound URL.
 */
export async function verifySeeapiVideoWebhook(input: {
	rawBody: Uint8Array;
	timestampHeader: string | null;
	signatureHeader: string | null;
	signingKeyHeader: string | null;
	keys: Record<string, string>;
	nowSeconds?: number;
}): Promise<boolean> {
	try {
		const { rawBody, timestampHeader, signatureHeader, signingKeyHeader, keys } = input;
		if (
			!(rawBody instanceof Uint8Array) ||
			!timestampHeader ||
			!/^\d{1,16}$/.test(timestampHeader) ||
			!signatureHeader ||
			!/^v1=[0-9a-f]{64}$/i.test(signatureHeader) ||
			!signingKeyHeader ||
			!/^whkey_[A-Za-z0-9_-]{1,160}$/.test(signingKeyHeader) ||
			!keys ||
			!Object.prototype.hasOwnProperty.call(keys, signingKeyHeader)
		)
			return false;
		const secret = keys[signingKeyHeader];
		if (typeof secret !== "string" || secret.length === 0) return false;
		const timestamp = Number(timestampHeader);
		const nowSeconds = input.nowSeconds ?? Date.now() / 1000;
		if (
			!Number.isSafeInteger(timestamp) ||
			!Number.isFinite(nowSeconds) ||
			Math.abs(nowSeconds - timestamp) > 300
		)
			return false;
		const encoder = new TextEncoder();
		const prefix = encoder.encode(`${timestampHeader}.`);
		const signed = new Uint8Array(prefix.byteLength + rawBody.byteLength);
		signed.set(prefix);
		// Preserve byte offsets, non-ASCII data and any BOM; never JSON-normalize or decode.
		signed.set(rawBody, prefix.byteLength);
		const supplied = Uint8Array.from(signatureHeader.slice(3).match(/.{2}/g)!, (byte) =>
			Number.parseInt(byte, 16),
		);
		const key = await crypto.subtle.importKey(
			"raw",
			encoder.encode(secret),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["verify"],
		);
		return await crypto.subtle.verify("HMAC", key, supplied, signed);
	} catch {
		return false;
	}
}
