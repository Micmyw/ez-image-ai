export async function register() {
	if (!process.env.SENTRY_DSN || process.env.ERROR_MONITORING_ENABLED !== "true") return;
	if (process.env.NEXT_RUNTIME === "nodejs") await import("./sentry.server.config");
	if (process.env.NEXT_RUNTIME === "edge") await import("./sentry.edge.config");
}

export async function onRequestError(...args: unknown[]) {
	if (!process.env.SENTRY_DSN || process.env.ERROR_MONITORING_ENABLED !== "true") return;
	const Sentry = await import("@sentry/nextjs");
	return Sentry.captureRequestError(...(args as Parameters<typeof Sentry.captureRequestError>));
}
