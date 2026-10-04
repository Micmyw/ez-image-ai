import assert from "node:assert/strict";
import { test } from "node:test";

import { isLinuxBuildSource, linuxBuildEnvironment } from "./linux-build-policy.mjs";

await test("Linux snapshot contains source and additive migrations but excludes host secrets and generated links", () => {
	for (const file of [
		"apps/saas/cloudflare-worker.ts",
		"packages/database/prisma/schema.prisma",
		"packages/database/prisma/migrations/20261004000000_video_generation_v1/migration.sql",
		"apps/saas/public/images/example.webp",
		"pnpm-lock.yaml",
	])
		assert.equal(isLinuxBuildSource(file), true, file);
	for (const file of [
		".env.production.local",
		"apps/saas/.env",
		"apps/saas/.dev.vars",
		"secrets/private.key",
		".cache/build.log",
		"node_modules/.pnpm/next/package.json",
		"apps/saas/.source/index.ts",
		"apps/saas/.next/server.js",
		"packages/database/prisma/generated/client.ts",
		"packages/database/prisma/zod/index.ts",
		"../outside.ts",
		"C:/private.ts",
		"/private.ts",
	])
		assert.equal(isLinuxBuildSource(file), false, file);
});

await test("isolated build forwards explicit public inputs and ignores every real credential or preload", () => {
	const env = linuxBuildEnvironment({
		NEXT_PUBLIC_SAAS_URL: "https://ezimageai.com",
		NEXT_PUBLIC_UNKNOWN_SECRET: "private",
		DATABASE_URL: "real-secret",
		KIE_API_KEY: "private",
		CLOUDFLARE_API_TOKEN: "private",
		NODE_OPTIONS: "--import=/outside.mjs",
		VIDEO_V1_ENABLED: "true",
	});
	assert.equal(env.NEXT_PUBLIC_SAAS_URL, "https://ezimageai.com");
	assert.equal(env.VIDEO_V1_ENABLED, "false");
	assert.equal(env.DATABASE_URL, "postgresql://build:build@127.0.0.1:1/build_only");
	assert.equal(JSON.stringify(env).includes("private"), false);
	assert.equal(env.NODE_OPTIONS, undefined);
});
