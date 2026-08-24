export interface EditorQuoteRequest {
	version: number;
}

export interface EditorActionController {
	beginQuoteRequest(): EditorQuoteRequest;
	acceptQuote(request: EditorQuoteRequest): boolean;
	idempotencyKeyFor(quoteId: string): string;
	invalidate(): void;
}

export function createEditorActionController(
	createIdempotencyKey: () => string = () => crypto.randomUUID(),
): EditorActionController {
	let version = 0;
	let confirmation: { quoteId: string; idempotencyKey: string } | null = null;

	return {
		beginQuoteRequest: () => ({ version }),
		acceptQuote: (request) => request.version === version,
		idempotencyKeyFor(quoteId) {
			if (confirmation?.quoteId !== quoteId) {
				confirmation = { quoteId, idempotencyKey: createIdempotencyKey() };
			}
			return confirmation.idempotencyKey;
		},
		invalidate() {
			version += 1;
			confirmation = null;
		},
	};
}
