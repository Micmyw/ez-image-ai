import { withContentCollections } from "@content-collections/next";
import type { NextConfig } from "next";
import nextIntlPlugin from "next-intl/plugin";

const withNextIntl = nextIntlPlugin("./modules/i18n/request.ts");

const isProduction = process.env.NODE_ENV === "production";
const e2eSaasConnectSource = resolveE2ESaasConnectSource();
const contentSecurityPolicy = [
	"default-src 'self'",
	"base-uri 'self'",
	`form-action 'self' https:${e2eSaasConnectSource ? ` ${e2eSaasConnectSource}` : ""}`,
	"frame-ancestors 'none'",
	"object-src 'none'",
	"script-src 'self' 'unsafe-inline' https:" + (isProduction ? "" : " 'unsafe-eval'"),
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' blob: data: https:",
	"font-src 'self' data:",
	`connect-src 'self' https:${e2eSaasConnectSource ? ` ${e2eSaasConnectSource}` : ""}${isProduction ? "" : " ws: http:"}`,
	"worker-src 'self' blob:",
	...(isProduction ? ["upgrade-insecure-requests"] : []),
].join("; ");

const securityHeaders = [
	{ key: "Content-Security-Policy", value: contentSecurityPolicy },
	{ key: "X-Content-Type-Options", value: "nosniff" },
	{ key: "X-Frame-Options", value: "DENY" },
	{ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
	{ key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
	...(isProduction
		? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]
		: []),
];

const nextConfig: NextConfig = {
	transpilePackages: ["@repo/i18n", "@repo/logs", "@repo/ui"],
	images: {
		remotePatterns: [
			{
				protocol: "https",
				hostname: "placehold.co",
			},
			{
				protocol: "https",
				hostname: "picsum.photos",
			},
		],
	},
	async headers() {
		return [{ source: "/(.*)", headers: securityHeaders }];
	},
};

export default withContentCollections(withNextIntl(nextConfig));

function resolveE2ESaasConnectSource(): string | null {
	if (process.env.E2E_DRAFT_HANDOFF !== "true" || !process.env.NEXT_PUBLIC_SAAS_URL) return null;
	try {
		const url = new URL(process.env.NEXT_PUBLIC_SAAS_URL);
		return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
			? url.origin
			: null;
	} catch {
		return null;
	}
}
