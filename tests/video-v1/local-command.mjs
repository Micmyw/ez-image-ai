import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Shadow environment-file keys with local-only values before Next/dotenv can load
// them. Values from developer/production files are never parsed, copied or logged.
const environment = { ...process.env };
for (const directory of [".", "apps/saas", "apps/workflows"]) {
	for (const name of [
		".env",
		".env.local",
		".env.development",
		".env.development.local",
		".env.production",
		".env.production.local",
		".env.test",
		".env.test.local",
	]) {
		const path = resolve(directory, name);
		if (!existsSync(path)) continue;
		for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
			const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z_0-9]*)\s*=/.exec(line)?.[1];
			if (key) environment[key] = "";
		}
	}
}
for (const key of Object.keys(environment)) {
	if (
		/(?:API_KEY|API_TOKEN|SECRET|PASSWORD|DATABASE_URL|S3_ENDPOINT|S3_ACCESS|S3_SECRET|WEBHOOK|AUTHORIZATION)/.test(
			key,
		)
	)
		environment[key] = "";
}
const database = process.env.VIDEO_VERIFICATION_DATABASE_URL;
if (
	!database ||
	!["localhost", "127.0.0.1"].includes(new URL(database).hostname) ||
	!new URL(database).pathname.includes("test")
)
	throw new Error("EXPLICIT_ISOLATED_VIDEO_VERIFICATION_DATABASE_REQUIRED");
Object.assign(environment, {
	DATABASE_URL: "postgresql://video_build:video_build@127.0.0.1:1/video_build_only",
	TEST_DATABASE_URL: database,
	VIDEO_VERIFICATION_DATABASE_URL: database,
	NEXT_PUBLIC_SAAS_URL: "http://127.0.0.1:3349",
	NEXT_PUBLIC_SITE_URL: "http://127.0.0.1:3349",
	BETTER_AUTH_SECRET: "local-video-verification-secret-never-production-20261004",
	RESEND_API_KEY: "re_local_video_verification_not_used",
	S3_ENDPOINT: "http://127.0.0.1:59000",
	S3_REGION: "us-east-1",
	S3_ACCESS_KEY_ID: "video_test",
	S3_SECRET_ACCESS_KEY: "video_test_secret",
	MEDIA_BUCKET_NAME: "video-v1-test",
	NEXT_PUBLIC_AVATARS_BUCKET_NAME: "video-v1-avatar-test",
	VIDEO_V1_ENABLED: "false",
	MEDIA_GENERATION_ENABLED: "false",
	MODERATION_TEXT_WAFFO_ENABLED: "false",
	MODERATION_IMAGE_SEEAPI_ENABLED: "false",
	BILLING_ENABLED: "false",
	GUEST_MEDIA_ENABLED: "false",
	CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
	WRANGLER_SEND_METRICS: "false",
	NODE_OPTIONS: `--import=${pathToFileURL(resolve("tests/video-v1/no-paid-network.mjs")).href}`,
});
const command = process.argv[2];
if (
	![
		"test:unit:contracts",
		"test:api:contracts",
		"test:saas:contracts",
		"test:video:flow",
		"test:video:admission",
		"test:video:unit",
		"test:video:integration",
		"test:video:database",
		"test:video:ui",
		"test:integration",
		"test:integration:api",
		"verify:invariants",
		"type-check",
		"cloudflare:web:build",
		"e2e:media:ci",
		"e2e:media:remaining",
		"e2e:media:guest",
		"e2e:media:avatar",
		"e2e:media:landing-focus",
		"e2e:media:avatar-landing",
		"e2e:media:video-ui",
	].includes(command)
)
	throw new Error("LOCAL_VERIFICATION_COMMAND_NOT_ALLOWED");
environment.VIDEO_TEST_ALLOW_FONT_DOWNLOADS = [
	"cloudflare:web:build",
	"e2e:media:ci",
	"e2e:media:remaining",
	"e2e:media:guest",
	"e2e:media:avatar",
	"e2e:media:landing-focus",
	"e2e:media:avatar-landing",
	"e2e:media:video-ui",
].includes(command)
	? "true"
	: "false";
if (command.startsWith("e2e:media:")) {
	environment.E2E_RUN_ID = `video-v1-${Date.now().toString(36)}`;
	environment.E2E_USER_PASSWORD = "LocalMediaE2E!2026";
	environment.E2E_USE_PRODUCTION_BUILD = "false";
}
// These release-only overrides must be absent for the release-preflight fixtures.
// Empty values intentionally fail validation. This is a unit command: provider
// network remains blocked and all database consumers use the declared local DB.
if (["test:unit:contracts", "test:api:contracts", "test:saas:contracts"].includes(command)) {
	for (const key of [
		"SEEAPI_API_KEY",
		"MODERATION_TEXT_WAFFO_ENABLED",
		"MODERATION_IMAGE_SEEAPI_ENABLED",
		"GUEST_RISK_BUDGET_MICROS",
		"GUEST_HARD_BUDGET_MICROS",
		"GUEST_SESSION_MAX_ACCEPTED_PER_DAY",
		"GUEST_DEVICE_MAX_ACCEPTED_PER_DAY",
		"GUEST_IP_MAX_PER_10_MINUTES",
		"NEXT_PUBLIC_SITE_NAME",
		"MEDIA_DAILY_PROVIDER_COST_BUDGET_MICROS",
		"MEDIA_ENABLED_PROVIDERS",
		"PAYPAL_ENVIRONMENT",
	])
		delete environment[key];
}
const contractCommands = {
	"test:video:unit": ["test:video-v1"],
	"test:video:integration": ["test:video-v1:integration"],
	"test:video:database": [
		"--filter",
		"@repo/database",
		"exec",
		"vitest",
		"run",
		"video-v1",
		"--config",
		"vitest.integration.config.ts",
		"--configLoader",
		"runner",
	],
	"test:video:ui": [
		"--filter",
		"saas",
		"exec",
		"vitest",
		"run",
		"--root",
		"../..",
		"--config",
		"apps/saas/modules/video-v1/vitest.config.ts",
	],
	"test:video:flow": [
		"--filter",
		"@repo/jobs",
		"exec",
		"vitest",
		"run",
		"src/video-v1/flow.database.integration.test.ts",
		"src/video-v1/seeapi-flow.database.integration.test.ts",
		"--config",
		"vitest.config.ts",
	],
	"test:video:admission": [
		"--filter",
		"@repo/database",
		"exec",
		"vitest",
		"run",
		"prisma/queries/media/video-v1.integration.test.ts",
		"prisma/queries/media/video-v1-execution.integration.test.ts",
		"--config",
		"vitest.integration.config.ts",
	],
	"test:api:contracts": [
		"--filter",
		"@repo/api",
		"exec",
		"vitest",
		"run",
		"--exclude",
		"**/*.integration.test.ts",
	],
	"test:saas:contracts": ["--filter", "saas", "test"],
};
// Tests opt in explicitly; runtime configuration never infers a test provider.
if (command.startsWith("test:")) {
	Object.assign(environment, {
		NODE_ENV: "test",
		MEDIA_SAFETY_ADAPTER: "test",
		MEDIA_ALLOW_TEST_SAFETY_ADAPTER: "true",
	});
}
const integrationCommands = {
	"test:integration:api": ["exec", "tsx", "tests/load/run-integration.ts", "api"],
};
const browserCommands = {
	"e2e:media:remaining": ["--filter", "@repo/e2e-media", "run", "e2e", "--video-regression"],
	"e2e:media:guest": ["--filter", "@repo/e2e-media", "run", "e2e", "--guest-only"],
	"e2e:media:avatar": ["--filter", "@repo/e2e-media", "run", "e2e", "--avatar-only"],
	"e2e:media:landing-focus": ["--filter", "@repo/e2e-media", "run", "e2e", "--landing-regression"],
	"e2e:media:avatar-landing": ["--filter", "@repo/e2e-media", "run", "e2e", "--avatar-landing"],
	"e2e:media:video-ui": ["--filter", "@repo/e2e-media", "run", "e2e", "--video-ui"],
};
// The aggregate integration runner validates TEST_DATABASE_URL against the
// non-test application URL before assigning the isolated DB to its children.
if (command in contractCommands && command !== "test:video:integration")
	environment.DATABASE_URL = database;
const args =
	browserCommands[command] ??
	integrationCommands[command] ??
	contractCommands[command] ??
	(command === "type-check" ? ["exec", "turbo", "type-check"] : [command]);
if (command in contractCommands) args.push(...process.argv.slice(3));
const child = spawn(
	process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "pnpm",
	process.platform === "win32" ? ["/d", "/s", "/c", "pnpm", ...args] : args,
	{ cwd: process.cwd(), env: environment, stdio: "inherit" },
);
mkdirSync(".cache/video-v1", { recursive: true });
writeFileSync(
	`.cache/video-v1/process-${command.replaceAll(":", "-")}.json`,
	JSON.stringify({
		command,
		launcher: process.pid,
		child: child.pid,
		startedAt: new Date().toISOString(),
	}),
);
child.once("error", (error) => {
	console.error(error.message);
	process.exitCode = 1;
});
child.once("exit", (code) => {
	process.exitCode = code ?? 1;
});
