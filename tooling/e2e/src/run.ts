import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";

import { assertLocalMediaE2E } from "./guard";

const workspaceRoot = process.cwd().replace(/[\\/]tooling[\\/]e2e$/, "");
const runId =
	process.env.E2E_RUN_ID ?? `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
const saasOrigin = process.env.NEXT_PUBLIC_SAAS_URL ?? "http://localhost:3000";
const environment = {
	...process.env,
	E2E_TEST_MEDIA_ADAPTERS: "true",
	E2E_DRAFT_HANDOFF: "true",
	E2E_RUN_ID: runId,
	DATABASE_URL: process.env.TEST_DATABASE_URL,
	NEXT_PUBLIC_SAAS_URL: saasOrigin,
	NEXT_PUBLIC_MARKETING_URL: saasOrigin,
	MEDIA_BUCKET_NAME: process.env.MEDIA_BUCKET_NAME ?? "media-private",
	S3_ENDPOINT: process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000",
	S3_REGION: process.env.S3_REGION ?? "auto",
	S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID ?? "minioadmin",
	S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY ?? "minioadmin",
	BETTER_AUTH_SECRET:
		process.env.BETTER_AUTH_SECRET ?? "local-media-e2e-secret-must-never-be-used-outside-tests",
	RESEND_API_KEY: process.env.RESEND_API_KEY ?? "re_local_media_e2e_not_used",
	E2E_USER_PASSWORD: process.env.E2E_USER_PASSWORD ?? "LocalMediaE2E!2026",
	PRICE_ID_CREATOR_MONTHLY: "",
	PRICE_ID_CREATOR_YEARLY: "",
	PRICE_ID_STUDIO_MONTHLY: "",
	PRICE_ID_STUDIO_YEARLY: "",
	MEDIA_GENERATION_ENABLED: "true",
	MEDIA_STANDARD_EDIT_ENABLED: "true",
	MEDIA_QUALITY_EDIT_ENABLED: "true",
	MEDIA_MODERATION_ENABLED: "true",
	MEDIA_DAILY_PROVIDER_COST_BUDGET_MICROS: "250000000",
	MEDIA_PROVIDER_ADAPTER: "mock",
	MEDIA_ENABLED_PROVIDERS: "replicate,fal,kie,gemini",
	MEDIA_SAFETY_ADAPTER: "test",
	MEDIA_ALLOW_TEST_SAFETY_ADAPTER: "true",
	GUEST_MEDIA_ENABLED: "true",
	GUEST_PROMOTION_PERIOD: `local-e2e-${runId}`,
	GUEST_ABUSE_HMAC_SECRET: "local-e2e-guest-abuse-hmac-secret-not-for-production",
	GUEST_ABUSE_HMAC_VERSION: "local-e2e-v1",
	GUEST_RISK_BUDGET_MICROS: "250000",
	GUEST_COST_EVIDENCE_ID: "",
	GUEST_HARD_BUDGET_MICROS: undefined,
	NEXT_PUBLIC_GUEST_TURNSTILE_SITE_KEY: "",
	GUEST_TURNSTILE_SECRET_KEY: "",
	MEDIA_TRUSTED_PROXY_PROVIDER: "",
	NODE_ENV: process.env.E2E_USE_PRODUCTION_BUILD === "true" ? "production" : "development",
};

assertLocalMediaE2E(environment);

async function main(): Promise<void> {
	let pump: ChildProcess | undefined;
	try {
		await command([
			"--filter",
			"@repo/database",
			"exec",
			"prisma",
			"migrate",
			"deploy",
			"--config",
			"prisma.config.ts",
		]);
		await command(["--filter", "@repo/e2e-media", "run", "seed"]);
		pump = spawn(process.execPath, ["--import", "tsx", "tooling/e2e/src/pump.ts"], {
			cwd: workspaceRoot,
			env: environment,
			stdio: "inherit",
		});
		await command([
			"--filter",
			"saas",
			"exec",
			"playwright",
			"test",
			"tests/media-generation.spec.ts",
			"tests/subscription-upgrade.spec.ts",
			"tests/seo.spec.ts",
			"--workers=1",
		]);
		await command([
			"--filter",
			"saas",
			"exec",
			"playwright",
			"test",
			"tests/guest-trial.spec.ts",
			"tests/landing.spec.ts",
			"tests/originality.spec.ts",
			"--project=guest",
			"--workers=1",
		]);
	} finally {
		pump?.kill();
		await command(["--filter", "@repo/e2e-media", "run", "cleanup"]);
	}
}

function command(arguments_: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = start(arguments_);
		child.once("exit", (code) =>
			code === 0 ? resolve() : reject(new Error(`pnpm ${arguments_.join(" ")} exited ${code}`)),
		);
	});
}

function start(arguments_: string[]): ChildProcess {
	return spawn("pnpm", arguments_, {
		cwd: workspaceRoot,
		env: environment,
		stdio: "inherit",
		shell: process.platform === "win32",
	});
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
