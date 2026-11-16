/** Kie HMAC authenticates task identity and timestamp only, never the callback body. */
export async function verifyKieWebhook(input: {
	taskId: string;
	timestamp: string | null;
	signature: string | null;
	secret: string;
	nowSeconds?: number;
}): Promise<boolean> {
	if (
		!/^[\w-]{1,160}$/.test(input.taskId) ||
		!input.secret.trim() ||
		!input.timestamp ||
		!/^\d{10}$/.test(input.timestamp) ||
		!input.signature ||
		!/^[A-Za-z0-9+/]{43}=$/.test(input.signature)
	)
		return false;
	const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
	const delta = now - Number(input.timestamp);
	if (delta > 300 || delta < -30) return false;
	try {
		const key = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(input.secret),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["verify"],
		);
		const signature = Uint8Array.from(atob(input.signature), (value) => value.charCodeAt(0));
		return await crypto.subtle.verify(
			"HMAC",
			key,
			signature,
			new TextEncoder().encode(`${input.taskId}.${input.timestamp}`),
		);
	} catch {
		return false;
	}
}
