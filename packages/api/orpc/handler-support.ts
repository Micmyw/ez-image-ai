export const apiDocsPath = "/docs";
export const apiSpecPath = "/spec.json";

// Constructor work contains no request I/O. Concurrent requests share it, and a failed load can retry.
export function initializeOnce<T>(initialize: () => Promise<T>): () => Promise<T> {
	let pending: Promise<T> | undefined;
	return () =>
		(pending ??= initialize().catch((error: unknown) => {
			pending = undefined;
			throw error;
		}));
}

export function safeRpcError(error: unknown): Record<string, unknown> {
	if (!(error instanceof Error)) return { kind: typeof error };
	const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
	return {
		name: error.name,
		code,
		message: error.message.slice(0, 200),
	};
}
