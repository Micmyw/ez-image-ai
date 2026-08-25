import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";

import { assertLocalMediaE2E } from "./guard";

const workspaceRoot = process.cwd().replace(/[\\/]tooling[\\/]e2e$/, "");
const environment = {
	...process.env,
	E2E_TEST_MEDIA_ADAPTERS: "true",
	E2E_DRAFT_HANDOFF: "true",
	E2E_RUN_ID:
		process.env.E2E_RUN_ID ?? `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
	DATABASE_URL: process.env.TEST_DATABASE_URL,
	NEXT_PUBLIC_SAAS_URL: process.env.NEXT_PUBLIC_SAAS_URL ?? "http://localhost:3000",
	NEXT_PUBLIC_MARKETING_URL: process.env.NEXT_PUBLIC_MARKETING_URL ?? "http://localhost:3001",
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
	MEDIA_MODERATION_ENABLED: "true",
	MEDIA_PROVIDER_ADAPTER: "mock",
	MEDIA_ENABLED_PROVIDERS: "replicate,fal,kie,gemini",
	MEDIA_SAFETY_ADAPTER: "test",
	MEDIA_ALLOW_TEST_SAFETY_ADAPTER: "true",
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
		]);
		await command([
			"--filter",
			"marketing",
			"exec",
			"playwright",
			"test",
			"tests/generator.spec.ts",
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
