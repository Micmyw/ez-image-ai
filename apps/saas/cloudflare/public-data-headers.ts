const contentSecurityPolicy = [
	"default-src 'none'",
	"img-src 'self'",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'none'",
	"object-src 'none'",
].join("; ");

/** Protect direct Worker data responses. Site documents have their own Next.js policy. */
export function setPublicDataSecurityHeaders(headers: Headers, https: boolean) {
	headers.set("Content-Security-Policy", contentSecurityPolicy);
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set("X-Frame-Options", "DENY");
	headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
	headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
	if (https)
		headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
	else headers.delete("Strict-Transport-Security");
}
