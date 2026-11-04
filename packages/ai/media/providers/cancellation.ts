/** Server-side adapter capability. A cancellation request is still not cancellation evidence. */
export function providerSupportsCancellation(provider: unknown): boolean {
	return provider === "replicate";
}
