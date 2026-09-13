/** Keep the HTTP contract intact; domain state and authorization stay in SaaS. */
export async function forwardToWebsite(
	request: Request,
	canonicalOrigin: string,
	fetchWebsite: (request: Request) => Promise<Response>,
	paymentWebhookOrigin?: string,
): Promise<Response> {
	try {
		const canonical = new URL(canonicalOrigin);
		const incoming = new URL(request.url);
		const alternateWebhook =
			Boolean(paymentWebhookOrigin) &&
			canonical.protocol === "https:" &&
			incoming.protocol === "https:" &&
			incoming.origin === paymentWebhookOrigin &&
			request.method === "POST" &&
			incoming.pathname === "/api/webhooks/payments" &&
			!incoming.search;
		if (
			canonical.protocol === "https:" &&
			incoming.protocol === "http:" &&
			incoming.host === canonical.host &&
			(request.method === "GET" || request.method === "HEAD")
		) {
			incoming.protocol = "https:";
			return new Response(null, {
				status: 308,
				headers: { location: incoming.href, "cache-control": "no-store" },
			});
		}
		if (incoming.origin !== canonical.origin && !alternateWebhook) {
			return new Response("Misdirected request", {
				status: 421,
				headers: { "cache-control": "no-store" },
			});
		}
		const headers = new Headers(request.headers);
		headers.delete("forwarded");
		headers.delete("x-forwarded-for");
		headers.set("host", canonical.host);
		headers.set("x-forwarded-host", canonical.host);
		headers.set("x-forwarded-proto", canonical.protocol.slice(0, -1));
		const clientIp = request.headers.get("cf-connecting-ip");
		if (clientIp) headers.set("x-forwarded-for", clientIp);
		const forwarded = alternateWebhook
			? new Request(new URL("/api/webhooks/payments", canonical), request)
			: request;
		return await fetchWebsite(new Request(forwarded, { headers }));
	} catch {
		return new Response("Service unavailable", {
			status: 503,
			headers: { "cache-control": "no-store", "retry-after": "30" },
		});
	}
}

export function websiteEnvironment(
	serialized: string,
	canonicalOrigin: string,
): Record<string, string> {
	let values: unknown;
	try {
		values = JSON.parse(serialized);
	} catch {
		throw new Error("INVALID_WEB_RUNTIME_ENV");
	}
	if (
		!values ||
		typeof values !== "object" ||
		Array.isArray(values) ||
		Object.entries(values).some(
			([key, value]) => !/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== "string",
		)
	) {
		throw new Error("INVALID_WEB_RUNTIME_ENV");
	}
	const environment = values as Record<string, string>;
	if (environment.NEXT_PUBLIC_SAAS_URL !== canonicalOrigin) throw new Error("WEB_ORIGIN_MISMATCH");
	return {
		...environment,
		NODE_ENV: "production",
		HOSTNAME: "0.0.0.0",
		PORT: "8080",
		MEDIA_TRUSTED_PROXY_PROVIDER: "cloudflare",
	};
}
