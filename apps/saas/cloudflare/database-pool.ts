const diagnosticPaths = new Set([
	"/api/admin/media/diagnostics",
	"/api/admin/media/health",
	"/api/admin/media/totals",
	"/api/admin/media/guest-diagnostics",
	"/api/rpc/media/adminMediaDiagnostics",
	"/api/rpc/media/adminMediaHealth",
	"/api/rpc/media/adminMediaTotals",
	"/api/rpc/media/adminGuestDiagnostics",
]);

export function databasePoolSizeForRequest(request: Request): 1 | 2 {
	const path = new URL(request.url).pathname;
	const supportedMethod =
		request.method === "GET" || (request.method === "POST" && path.startsWith("/api/rpc/"));
	return supportedMethod && diagnosticPaths.has(path) ? 2 : 1;
}
