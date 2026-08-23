import { MediaProviderError, redactProviderError } from "../errors";
import type { ProviderFailure, ProviderSubmission } from "../types";

export interface HttpClientOptions {
	fetch?: typeof fetch;
	timeoutMs?: number;
}

export function rejectedHttpSubmission(input: {
	status: number;
	data: unknown;
	attemptId: string;
	providerIdempotencySupported?: boolean;
}): ProviderSubmission {
	const uncertain = [408, 409, 425, 429].includes(input.status) || input.status >= 500;
	return {
		status: "FAILED",
		failure: {
			code: `HTTP_${input.status}`,
			message: providerHttpMessage(input.data, input.status),
			retryable: false,
		},
		outcome: uncertain ? "uncertain" : "rejected",
		idempotency:
			input.providerIdempotencySupported === false
				? { providerSupported: false, replayed: false }
				: { key: input.attemptId, providerSupported: true, replayed: false },
		reconciliation: { submissionToken: input.attemptId },
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
		const response = await (options.fetch ?? fetch)(url, { ...init, signal: controller.signal });
		let data: unknown;
		const body = await response.text();
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
