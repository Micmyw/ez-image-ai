import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { assertSafeDatabaseUrl } from "../load/assert-safe-target";

const integration = process.argv.includes("--integration");
const hotelLobby = process.argv.includes("--hotel-lobby");
const databaseUrl = integration
	? assertSafeDatabaseUrl(process.env.TEST_DATABASE_URL).toString()
	: "postgresql://video_test:video_test@127.0.0.1:1/video_unit_test";
const environment = { ...process.env };
for (const key of Object.keys(environment)) {
	if (
		/(?:API_KEY|API_TOKEN|SECRET|PASSWORD|DATABASE_URL|S3_ENDPOINT|S3_ACCESS|S3_SECRET|WEBHOOK|AUTHORIZATION)/.test(
			key,
		)
	)
		delete environment[key];
}
Object.assign(environment, {
	NODE_ENV: "test",
	VIDEO_V1_TEST_ONLY: "true",
	VIDEO_TEST_ALLOW_FONT_DOWNLOADS: "false",
	MEDIA_GENERATION_ENABLED: "false",
	VIDEO_V1_ENABLED: "false",
	DATABASE_URL: databaseUrl,
	...(integration
		? {
				TEST_DATABASE_URL: databaseUrl,
				// Propagate only the loopback test URL validated before environment scrubbing.
				VIDEO_VERIFICATION_DATABASE_URL: databaseUrl,
			}
		: {}),
	NODE_OPTIONS: `--import=${pathToFileURL(resolve("tests/video-v1/no-paid-network.mjs")).href}`,
});
const commands = integration
	? [
			[
				"--filter",
				"@repo/database",
				"exec",
				"vitest",
				"run",
				hotelLobby ? "video" : "video-v1",
				"--config",
				"vitest.integration.config.ts",
				"--configLoader",
				"runner",
			],
			[
				"--filter",
				"@repo/jobs",
				"exec",
				"vitest",
				"run",
				"src/video-v1/flow.database.integration.test.ts",
				"src/video-v1/seeapi-flow.database.integration.test.ts",
				...(hotelLobby ? ["src/video-v1/template-flow.database.integration.test.ts"] : []),
				"src/handlers/legacy-engine-isolation.database.integration.test.ts",
				"--config",
				"vitest.config.ts",
			],
		]
	: [
			["--filter", "@repo/config", "exec", "vitest", "run", "video"],
			[
				"--filter",
				"@repo/ai",
				"exec",
				"vitest",
				"run",
				"video",
				...(hotelLobby ? ["template-scene"] : []),
			],
			[
				"--filter",
				"@repo/storage",
				"exec",
				"vitest",
				"run",
				"video-mp4",
				...(hotelLobby ? ["template-scene"] : []),
			],
			[
				"--filter",
				"@repo/jobs",
				"exec",
				"vitest",
				"run",
				"video-v1",
				...(hotelLobby ? ["video-effects"] : []),
				"--exclude",
				"**/*.integration.test.ts",
			],
			[
				"--filter",
				"@repo/api",
				"exec",
				"vitest",
				"run",
				"video-v1",
				...(hotelLobby ? ["video-effects"] : []),
				...(hotelLobby ? ["create-checkout-link", "create-credit-pack-checkout"] : []),
				"--exclude",
				"**/*.integration.test.ts",
			],
			[
				"--filter",
				"@repo/workflows",
				"exec",
				"vitest",
				"run",
				"--project",
				"unit",
				"src/video-orchestrator.test.ts",
			],
			[
				"--filter",
				"@repo/workflows",
				"exec",
				"vitest",
				"run",
				"--project",
				"video-workerd",
				"--project",
				"video-seeapi-workerd",
			],
			[
				"--filter",
				"@repo/web-host",
				"exec",
				"vitest",
				"run",
				"src/profiles.test.ts",
				...(hotelLobby ? ["src/build-secrets.test.ts", "src/deployment.test.ts"] : []),
			],
			[
				"--filter",
				"saas",
				"exec",
				"vitest",
				"run",
				"video-v1",
				...(hotelLobby
					? [
							"video-effects",
							"public-routes",
							"sitemap",
							"robots",
							"proxy",
							"editor-upgrade",
							"checkout-attempt",
							"CreditPackCheckoutReturn",
							"PublicPricingPlans",
							"PricingTable",
							"public-navigation",
							"growth-analytics",
						]
					: []),
			],
		];
for (const args of commands) {
	console.log(
		`\nvideo V1 ${integration ? "isolated database" : "unit/Mock"}: pnpm ${args.join(" ")}`,
	);
	const result = spawnSync(
		process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "pnpm",
		process.platform === "win32" ? ["/d", "/s", "/c", "pnpm", ...args] : args,
		{ cwd: process.cwd(), env: environment, stdio: "inherit" },
	);
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(
	"Video V1 verification complete; external network blocked; real paid generation calls: 0.",
);
