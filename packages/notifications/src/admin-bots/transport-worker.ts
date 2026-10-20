import type { BotPostJson } from "./types";

// The website and background Workers already require global_fetch_strictly_public.
// Capture native Internet fetch, never a service binding or VPC fetch capability.
const publicFetch = globalThis.fetch.bind(globalThis);

export const postBotJson: BotPostJson = async (url, body, headers) => {
	const response = await publicFetch(url.toString(), {
		method: "POST",
		headers: { ...headers, "Content-Type": "application/json" },
		body: JSON.stringify(body),
		redirect: "manual",
		signal: AbortSignal.timeout(8_000),
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`ADMIN_BOT_HTTP_${response.status}`);
	}
	const reader = response.body?.getReader();
	if (!reader) return null;
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > 16_384) {
				await reader.cancel();
				throw new Error("ADMIN_BOT_RESPONSE_TOO_LARGE");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return null;
	}
};
