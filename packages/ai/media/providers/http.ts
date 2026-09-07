import { MediaProviderError, redactProviderError } from "../errors";
import type { ProviderFailure, ProviderSubmission } from "../types";

export interface HttpClientOptions {
	fetch?: typeof fetch;
	maxResponseBytes?: number;
	timeoutMs?: number;
}

const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const RESPONSE_TOO_LARGE_MESSAGE = "Provider response exceeded the configured byte limit";

export function rejectedHttpSubmission(input: {
	status: number;
	data: unknown;
	attemptId: string;
	providerIdempotencySupported?: boolean;
}): ProviderSubmission {
	const uncertain = [408, 409, 425, 429].includes(input.status) || input.status >= 500;
	const base = {
		status: "FAILED" as const,
		failure: {
			code: `HTTP_${input.status}`,
			message: providerHttpMessage(input.data, input.status),
			retryable: false,
		},
		idempotency:
			input.providerIdempotencySupported === false
				? { providerSupported: false, replayed: false }
				: { key: input.attemptId, providerSupported: true, replayed: false },
		reconciliation: { submissionToken: input.attemptId },
	};
	if (uncertain) {
		return {
			...base,
			outcome: "uncertain",
			uncertainty: {
				classification: "ambiguous_http",
				phase: "post_send",
				statusCode: input.status,
			},
		};
	}
	return {
		...base,
		outcome: "rejected",
	};
}

function providerHttpMessage(data: unknown, status: number): ProviderFailure["message"] {
	if (typeof data === "string" && data.trim()) return data.trim().slice(0, 500);
	if (data && typeof data === "object" && !Array.isArray(data)) {
		for (const key of ["detail", "message", "error"] as const) {
			const value = (data as Record<string, unknown>)[key];
			if (typeof value === "string" && value.trim()) return value.slice(0, 500);
		}
	}
	return `Provider rejected submission with HTTP ${status}`;
}
export async function fetchJson(
	url: string,
	init: RequestInit,
	options: HttpClientOptions,
): Promise<{ ok: boolean; status: number; data: unknown }> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
	try {
		const maxResponseBytes = responseByteLimit(options.maxResponseBytes);
		const response = await (options.fetch ?? fetch)(url, { ...init, signal: controller.signal });
		let data: unknown;
		const body = await boundedResponseText(response, maxResponseBytes, controller);
		try {
			data = body ? (JSON.parse(body) as unknown) : null;
		} catch (error) {
			if (!response.ok) data = body.slice(0, 500);
			else {
				throw new MediaProviderError(
					"MALFORMED_PROVIDER_RESPONSE",
					"Provider returned invalid JSON",
					false,
					{ cause: error },
				);
			}
		}
		return { ok: response.ok, status: response.status, data };
	} catch (error) {
		if (error instanceof MediaProviderError) throw error;
		throw new MediaProviderError("HTTP_ERROR", redactProviderError(error), true, { cause: error });
	} finally {
		clearTimeout(timeout);
	}
}

function responseByteLimit(value: number | undefined): number {
	const limit = value ?? DEFAULT_MAX_RESPONSE_BYTES;
	if (!Number.isSafeInteger(limit) || limit <= 0) {
		throw new MediaProviderError(
			"MALFORMED_PROVIDER_RESPONSE",
			"Provider response byte limit was invalid",
			false,
		);
	}
	return limit;
}

async function boundedResponseText(
	response: Response,
	maxResponseBytes: number,
	controller: AbortController,
): Promise<string> {
	if (declaredResponseLengthExceeds(response.headers, maxResponseBytes)) {
		cancelResponseBody(response.body);
		controller.abort();
		throw responseTooLargeError();
	}
	if (!response.body) return "";

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const parts: string[] = [];
	let totalBytes = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		totalBytes += value.byteLength;
		if (totalBytes > maxResponseBytes) {
			cancelResponseReader(reader);
			controller.abort();
			throw responseTooLargeError();
		}
		parts.push(decoder.decode(value, { stream: true }));
	}
	parts.push(decoder.decode());
	return parts.join("");
}

function declaredResponseLengthExceeds(headers: Headers, maxResponseBytes: number): boolean {
	const value = headers.get("content-length")?.trim();
	if (!value || !/^\d+$/.test(value)) return false;
	return BigInt(value) > BigInt(maxResponseBytes);
}

function cancelResponseBody(body: ReadableStream<Uint8Array> | null): void {
	if (!body) return;
	try {
		void body.cancel().catch(() => undefined);
	} catch {
		// Cancellation is best effort; the shared abort signal still terminates the request.
	}
}

function cancelResponseReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
	try {
		void reader.cancel().catch(() => undefined);
	} catch {
		// Cancellation is best effort; the shared abort signal still terminates the request.
	}
}

function responseTooLargeError(): MediaProviderError {
	return new MediaProviderError("MALFORMED_PROVIDER_RESPONSE", RESPONSE_TOO_LARGE_MESSAGE, false);
}
