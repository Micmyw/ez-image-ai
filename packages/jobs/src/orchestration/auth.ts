const encoder = new TextEncoder();
export const MAX_DISPATCH_BYTES = 16_384;

async function signingKey(secret: string) {
	if (secret.length < 32) throw new Error("INVALID_DISPATCH_SECRET");
	return crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

function signedContent(method: string, path: string, timestamp: string, body: string) {
	return encoder.encode(`${method}\n${path}\n${timestamp}\n${body}`);
}

export async function signRequest(
	secret: string,
	method: string,
	path: string,
	body: string,
	now = Date.now(),
): Promise<Headers> {
	const timestamp = String(now);
	const signature = await crypto.subtle.sign(
		"HMAC",
		await signingKey(secret),
		signedContent(method, path, timestamp, body),
	);
	return new Headers({
		"content-type": "application/json",
		"x-jobs-timestamp": timestamp,
		"x-jobs-signature": Array.from(new Uint8Array(signature), (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join(""),
	});
}

export async function verifyRequest(
	secret: string,
	method: string,
	path: string,
	body: string,
	headers: Headers,
	now = Date.now(),
): Promise<boolean> {
	const timestamp = headers.get("x-jobs-timestamp") ?? "";
	const signature = headers.get("x-jobs-signature") ?? "";
	if (
		secret.length < 32 ||
		!/^\d{13}$/.test(timestamp) ||
		Math.abs(now - Number(timestamp)) > 60_000 ||
		!/^[a-f0-9]{64}$/.test(signature)
	)
		return false;
	const bytes = Uint8Array.from(signature.match(/../g)!, (pair) => Number.parseInt(pair, 16));
	return crypto.subtle.verify(
		"HMAC",
		await signingKey(secret),
		bytes,
		signedContent(method, path, timestamp, body),
	);
}

export async function readBoundedBody(
	request: Request,
	maxBytes = MAX_DISPATCH_BYTES,
): Promise<string> {
	const reader = request.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const part = await reader.read();
			if (part.done) break;
			length += part.value.byteLength;
			if (length > maxBytes) {
				await reader.cancel();
				throw new Error("BODY_TOO_LARGE");
			}
			chunks.push(part.value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}

export async function workflowInstanceId(value: unknown): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(value)));
	return `job-${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
