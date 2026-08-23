export class MediaProviderError extends Error {
	readonly originalCause: unknown;

	constructor(
		public readonly code:
			| "HTTP_ERROR"
			| "MALFORMED_PROVIDER_RESPONSE"
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

export function redactProviderError(value: unknown): string {
	const message = value instanceof Error ? value.message : String(value);
	return message
		.replace(/(?:bearer|token|key|secret)\s*[=:]\s*[^\s,]+/gi, "$1=[REDACTED]")
		.slice(0, 500);
}
