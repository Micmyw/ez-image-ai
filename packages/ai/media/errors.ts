import { sanitizeProviderDiagnosticMessage } from "@repo/config/provider-diagnostics";

export class MediaProviderError extends Error {
	readonly originalCause: unknown;

	constructor(
		public readonly code:
			| "HTTP_ERROR"
			| "MALFORMED_PROVIDER_RESPONSE"
			| "UNSUPPORTED_INPUT"
			| "WEBHOOK_VERIFICATION_FAILED",
		message: string,
		public readonly retryable: boolean,
		options?: { cause?: unknown },
	) {
		super(message);
		this.name = "MediaProviderError";
		this.originalCause = options?.cause;
	}
}

export function redactProviderError(
	value: unknown,
	sensitiveValues: readonly string[] = [],
): string {
	const message = value instanceof Error ? value.message : String(value);
	return sanitizeProviderDiagnosticMessage(message, sensitiveValues) ?? "Provider request failed";
}
