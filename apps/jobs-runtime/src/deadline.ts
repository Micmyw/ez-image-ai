/** A hung Node task cannot hold the paid Container alive indefinitely. */
export function executionDeadline(seconds: number, terminate: () => void): () => void {
	const timer = setTimeout(terminate, seconds * 1000);
	timer.unref();
	return () => clearTimeout(timer);
}
