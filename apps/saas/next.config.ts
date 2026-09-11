import path from "node:path";

// @ts-expect-error - PrismaPlugin is not typed
import { PrismaPlugin } from "@prisma/nextjs-monorepo-workaround-plugin";
import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";
import nextIntlPlugin from "next-intl/plugin";

import { resolveStorageConnectOrigin } from "./storage-connect-origin";

const withNextIntl = nextIntlPlugin("./modules/i18n/request.ts");
const withMDX = createMDX({
	configPath: "source.config.ts",
	outDir: ".source",
});

const isProduction = process.env.NODE_ENV === "production";
const isWorkersBuild = process.env.EZPIC_WORKERS_BUILD === "true";
const storageConnectSource = resolveStorageConnectOrigin(process.env.S3_ENDPOINT, {
	allowLoopbackHttp: !isProduction || process.env.E2E_TEST_MEDIA_ADAPTERS === "true",
});
const contentSecurityPolicy = [
	"default-src 'self'",
	"base-uri 'self'",
	"form-action 'self'",
	"frame-ancestors 'none'",
	"object-src 'none'",
	"script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://www.clarity.ms https://scripts.clarity.ms" +
		(isProduction ? "" : " 'unsafe-eval'"),
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' blob: data: https:",
	"media-src 'self' blob: https:",
	"font-src 'self' data:",
	`connect-src 'self' https:${storageConnectSource ? ` ${storageConnectSource}` : ""}${isProduction ? "" : " ws:"}`,
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
	...(process.env.EZPIC_STANDALONE_BUILD === "true"
		? { output: "standalone", outputFileTracingRoot: path.resolve(import.meta.dirname, "../..") }
		: {}),
	transpilePackages: ["@repo/api", "@repo/auth", "@repo/database", "@repo/logs", "@repo/ui"],
	...(isWorkersBuild
		? { serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pg"] }
		: {}),
	images: {
		remotePatterns: [
			{
				// google profile images
				protocol: "https",
				hostname: "lh3.googleusercontent.com",
			},
			{
				// github profile images
				protocol: "https",
				hostname: "avatars.githubusercontent.com",
			},
		],
	},
	async headers() {
		return [
			{ source: "/(.*)", headers: securityHeaders },
			{
				source: "/docs/:path*",
				headers: [{ key: "X-Robots-Tag", value: "noindex, follow" }],
			},
		];
	},
	async redirects() {
		return [
			{
				source: "/legal/privacy-policy",
				destination: "/privacy",
				permanent: true,
			},
			{
				source: "/legal/terms",
				destination: "/terms",
				permanent: true,
			},
			{
				source: "/:locale(de|es|fr)",
				destination: "/",
				permanent: true,
			},
			{
				source: "/:locale(de|es|fr)/:path*",
				destination: "/:path*",
				permanent: true,
			},
			{
				source: "/settings",
				destination: "/settings/general",
				permanent: true,
			},
			{
				source: "/:organizationSlug/settings",
				destination: "/:organizationSlug/settings/general",
				permanent: true,
			},
			{
				source: "/admin",
				destination: "/admin/users",
				permanent: true,
			},
		];
	},
	webpack: (config, { webpack, isServer }) => {
		config.plugins.push(
			new webpack.IgnorePlugin({
				resourceRegExp: isWorkersBuild ? /^pg-native$/ : /^pg-native$|^cloudflare:sockets$/,
			}),
		);

		if (isServer && isWorkersBuild) {
			// Select worker-safe package implementations before Next bundles shared code.
			config.resolve.conditionNames = ["workerd", ...(config.resolve.conditionNames ?? ["..."])];
			// Keep Prisma's precompiled module import for OpenNext/Wrangler. Webpack's
			// WASM loader would compile bytes at runtime, which Workers does not permit.
			config.plugins.push(
				new webpack.ExternalsPlugin(
					"import",
					(
						{ context, request }: { context?: string; request?: string },
						callback: (error?: Error, result?: string) => void,
					) => {
						if (context && request?.startsWith(".") && /\.wasm\?module$/.test(request)) {
							callback(undefined, path.resolve(context, request));
							return;
						}
						callback();
					},
				),
			);
		}

		if (isServer) {
			config.plugins.push(new PrismaPlugin());
		}

		return config;
	},
};

export default withMDX(withNextIntl(nextConfig));
