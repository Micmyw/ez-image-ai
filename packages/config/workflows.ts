export interface WorkflowsConfiguration {
	dispatchUrl: string;
	dispatchSecret: string;
}

/** Server-only dispatch configuration; never include these values in public diagnostics. */
export function assertWorkflowsConfiguration(
	input: Record<string, unknown>,
): WorkflowsConfiguration {
	const dispatchUrl = input.WORKFLOWS_DISPATCH_URL;
	if (typeof dispatchUrl !== "string" || !dispatchUrl || dispatchUrl.trim() !== dispatchUrl) {
		throw new Error("WORKFLOWS_DISPATCH_URL is invalid");
	}
	let url: URL;
	try {
		url = new URL(dispatchUrl);
	} catch {
		throw new Error("WORKFLOWS_DISPATCH_URL is invalid");
	}
	const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	const secure = url.protocol === "https:";
	const localDevelopment = input.NODE_ENV !== "production" && loopback && url.protocol === "http:";
	if (
		(!secure && !localDevelopment) ||
		(input.NODE_ENV === "production" && loopback) ||
		url.username ||
		url.password ||
		url.pathname !== "/internal/dispatch" ||
		url.search ||
		url.hash
	) {
		throw new Error("WORKFLOWS_DISPATCH_URL is invalid");
	}
	const dispatchSecret = input.WORKFLOWS_DISPATCH_SECRET;
	if (
		typeof dispatchSecret !== "string" ||
		dispatchSecret.length < 32 ||
		dispatchSecret.trim() !== dispatchSecret
	) {
		throw new Error("WORKFLOWS_DISPATCH_SECRET must contain at least 32 characters");
	}
	return { dispatchUrl, dispatchSecret };
}
