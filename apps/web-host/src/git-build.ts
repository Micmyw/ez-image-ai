import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

import { readCloudflareBuildEnvironment, withoutCloudflareBuildSecrets } from "./build-secrets";
import { deploymentEnvironment, publicBuildVariables } from "./deployment";
import {
	assertAutomaticReleaseEnvironment,
	assertCloudflareGitCommit,
	migrationDatabaseUrl,
} from "./release-environment";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const inputFile = path.join(root, ".wrangler/ci/production.env");
const prepared = path.join(root, ".wrangler/deploy/production/workers");
const command = process.argv[2];
const target = process.argv[3];
if (target !== "website" && target !== "jobs") throw new Error("EXPECTED_WEBSITE_OR_JOBS_TARGET");

function parseEnvironment(source: string): Record<string, string> {
	return Object.fromEntries(
		Object.entries(parseEnv(source)).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string",
		),
	);
}

function runPnpm(args: string[], environment: NodeJS.ProcessEnv = process.env) {
	if (!process.env.npm_execpath) throw new Error("RUN_RELEASE_COMMAND_WITH_PNPM");
	const result = spawnSync(process.execPath, [process.env.npm_execpath, ...args], {
		cwd: root,
		env: withoutCloudflareBuildSecrets(environment),
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`RELEASE_COMMAND_FAILED: ${args.join(" ")}`);
}

async function readEnvironment() {
	return parseEnvironment(await readFile(inputFile, "utf8"));
}

if (command === "build") {
	const source = readCloudflareBuildEnvironment(process.env);
	const input = parseEnvironment(source);
	const environment = deploymentEnvironment(input, "https://ezimageai.com");
	assertAutomaticReleaseEnvironment(environment);
	migrationDatabaseUrl(input, root);
	const sha = releaseSha();
	await mkdir(path.dirname(inputFile), { recursive: true });
	// This file deliberately lives outside Next.js dotenv discovery.
	await writeFile(inputFile, `${source}\nDEPLOYMENT_VERSION=${sha}\n`, { mode: 0o600 });
	const childEnvironment = { ...process.env };
	delete childEnvironment.CLOUDFLARE_PRODUCTION_ENV;
	delete childEnvironment.CLOUDFLARE_API_TOKEN;
	delete childEnvironment.WORKERS_CI_WORKER_NAME;
	runPnpm(["--filter", "@repo/database", "generate"], {
		...childEnvironment,
		DATABASE_URL: "postgresql://build:build@127.0.0.1:1/build_only",
	});
	runPnpm(["cloudflare:prepare", "production", inputFile], childEnvironment);
	const databaseUrl = migrationDatabaseUrl(input, root);
	// Read-only: pending/failed migrations stop deployment; migrations are applied separately.
	runPnpm(["--filter", "@repo/database", "exec", "prisma", "migrate", "status"], {
		...childEnvironment,
		DATABASE_URL: databaseUrl,
	});
	if (target === "jobs") {
		runPnpm(
			[
				"--filter",
				"@repo/workflows",
				"exec",
				"wrangler",
				"deploy",
				"--dry-run",
				"--config",
				path.join(prepared, "workflows.json"),
				"--outdir",
				"dist-workers",
			],
			childEnvironment,
		);
	} else {
		const publicEnvironment = publicBuildVariables(
			parseEnvironment(await readFile(path.join(prepared, "public-build.env"), "utf8")),
		);
		runPnpm(["cloudflare:web:build"], {
			...childEnvironment,
			...publicEnvironment,
			NODE_ENV: "production",
			DATABASE_URL: "postgresql://build:build@127.0.0.1:1/build_only",
			BETTER_AUTH_SECRET: "ci-build-placeholder-auth-secret-only-0000",
			RESEND_API_KEY: "re_build_only_placeholder",
			MEDIA_GENERATION_ENABLED: "false",
			GUEST_MEDIA_ENABLED: "false",
			BILLING_ENABLED: "false",
			MEDIA_ALLOW_TEST_SAFETY_ADAPTER: "false",
		});
	}
} else if (command === "deploy") {
	const sha = releaseSha();
	const environment = await readEnvironment();
	if (environment.DEPLOYMENT_VERSION !== sha) throw new Error("BUILD_COMMIT_MISMATCH");
	assertAutomaticReleaseEnvironment(environment);
	const configName = target === "website" ? "website" : "workflows";
	const configPath = path.join(prepared, `${configName}.json`);
	const config = JSON.parse(await readFile(configPath, "utf8"));
	if (process.env.WORKERS_CI_WORKER_NAME && process.env.WORKERS_CI_WORKER_NAME !== config.name) {
		throw new Error("CLOUDFLARE_BUILD_WORKER_NAME_MISMATCH");
	}
	if (target === "website") {
		runPnpm(
			[
				"--filter",
				"saas",
				"exec",
				"opennextjs-cloudflare",
				"populateCache",
				"remote",
				"--config",
				configPath,
			],
			{
				...process.env,
				CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE:
					"postgresql://build:build@127.0.0.1:1/build_only",
			},
		);
	}
	runPnpm([
		"--filter",
		target === "website" ? "saas" : "@repo/workflows",
		"exec",
		"wrangler",
		"deploy",
		"--config",
		configPath,
		"--secrets-file",
		path.join(prepared, `${configName}.secrets.json`),
		"--tag",
		sha,
		"--message",
		`Cloudflare Git build ${sha}`,
	]);
	const evidence: string[] = [];
	for (const name of [configName]) {
		const config = JSON.parse(await readFile(path.join(prepared, `${name}.json`), "utf8"));
		const api = async <T>(suffix: string): Promise<T> => {
			const response = await fetch(
				`https://api.cloudflare.com/client/v4/accounts/${config.account_id}/workers/scripts/${config.name}/${suffix}`,
				{
					headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` },
					signal: AbortSignal.timeout(30_000),
				},
			);
			if (!response.ok) throw new Error(`DEPLOYMENT_VERIFICATION_API_FAILED: ${response.status}`);
			const body = (await response.json()) as { success: boolean; result: T };
			if (!body.success) throw new Error("DEPLOYMENT_VERIFICATION_API_FAILED");
			return body.result;
		};
		const result = await api<{
			deployments?: Array<{ versions?: Array<{ version_id: string; percentage: number }> }>;
		}>("deployments");
		const deployment = result.deployments?.[0];
		const versions = deployment?.versions;
		if (versions?.length !== 1 || versions[0].percentage !== 100) {
			throw new Error(`EXPECTED_FULL_DEPLOYMENT: ${config.name}`);
		}
		const version = await api<{ annotations?: Record<string, string> }>(
			`versions/${versions[0].version_id}`,
		);
		if (version.annotations?.["workers/tag"] !== sha) {
			throw new Error(`LIVE_VERSION_SHA_MISMATCH: ${config.name}`);
		}
		evidence.push(`${config.name}: version ${versions[0].version_id}, 100% traffic, ${sha}`);
	}
	for (const route of target === "website" ? ["/api/health", "/", "/docs", "/create"] : []) {
		const url = new URL(route, "https://ezimageai.com");
		const response = await fetch(url, {
			redirect: "manual",
			headers: { "Cache-Control": "no-cache" },
			signal: AbortSignal.timeout(30_000),
		});
		if (response.status !== 200) throw new Error(`LIVE_HTTP_FAILED: ${route} ${response.status}`);
		await response.arrayBuffer();
		evidence.push(`${url.toString()}: HTTP 200`);
	}
	const summary = `Production deployment verified for ${sha}\n\n${evidence.map((line) => `- ${line}`).join("\n")}\n`;
	console.log(summary);
} else {
	throw new Error("EXPECTED_BUILD_OR_DEPLOY");
}

function releaseSha() {
	const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
	const sha = result.stdout?.trim() ?? "";
	if (result.status !== 0 || !/^[a-f0-9]{40}$/.test(sha)) throw new Error("RELEASE_SHA_REQUIRED");
	assertCloudflareGitCommit(process.env, sha);
	return sha;
}
