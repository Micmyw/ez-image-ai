import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { assertSafeDatabaseUrl } from "./assert-safe-target";
import { isExplicitGuestVerificationTarget } from "./guest-verification-target";
import { isExplicitVideoVerificationTarget } from "./video-verification-target";

export interface IntegrationCommand {
	args: string[];
	environment: NodeJS.ProcessEnv;
}

/** Plan first so an invalid or shared target cannot launch even the first suite. */
export function buildIntegrationPlan(phase = "all"): IntegrationCommand[] {
	if (!["all", "api"].includes(phase)) throw new Error("UNKNOWN_INTEGRATION_PHASE");

	const testDatabaseUrl = assertSafeDatabaseUrl(process.env.TEST_DATABASE_URL).toString();
	if (!process.env.GUEST_TEST_DATABASE_URL) throw new Error("GUEST_TEST_DATABASE_URL is required");
	const guestTestDatabaseUrl = assertSafeDatabaseUrl(
		process.env.GUEST_TEST_DATABASE_URL,
	).toString();
	if (!isExplicitGuestVerificationTarget(new URL(guestTestDatabaseUrl)))
		throw new Error("ISOLATED_GUEST_TEST_DATABASE_REQUIRED");
	const databaseTargets = [new URL(testDatabaseUrl), new URL(guestTestDatabaseUrl)];
	const videoTestDatabaseUrl = assertSafeDatabaseUrl(
		process.env.VIDEO_VERIFICATION_DATABASE_URL,
	).toString();
	if (!isExplicitVideoVerificationTarget(new URL(videoTestDatabaseUrl)))
		throw new Error("ISOLATED_VIDEO_TEST_DATABASE_REQUIRED");
	assertDistinctDatabaseTargets([...databaseTargets, new URL(videoTestDatabaseUrl)]);
	const commands: IntegrationCommand[] = [];
	const isolatedGuestDatabaseTests = [
		"prisma/queries/media/anonymous-standard-schema.integration.test.ts",
		"prisma/queries/media/guest-admission.integration.test.ts",
		"prisma/queries/media/guest-bootstrap.integration.test.ts",
		"prisma/queries/media/guest-link.integration.test.ts",
		"prisma/queries/media/guest-retention.integration.test.ts",
		"prisma/queries/media/admin-growth-operations.integration.test.ts",
	] as const;
	const isolatedGuestJobsTests = [
		"src/handlers/runtime-stores.database.integration.test.ts",
	] as const;
	const isolatedVideoDatabaseTests = [
		"prisma/queries/media/video-v1-seeapi-handoff-invariant.integration.test.ts",
	] as const;

	if (phase === "all") {
		run(
			[
				"--filter",
				"@repo/database",
				"exec",
				"vitest",
				"run",
				"--config",
				"vitest.integration.config.ts",
				"--configLoader",
				"runner",
				...isolatedGuestDatabaseTests.flatMap((test) => ["--exclude", test]),
				...isolatedVideoDatabaseTests.flatMap((test) => ["--exclude", test]),
			],
			false,
			testDatabaseUrl,
		);
		run(
			[
				"--filter",
				"@repo/database",
				"exec",
				"vitest",
				"run",
				...isolatedGuestDatabaseTests,
				"--config",
				"vitest.integration.config.ts",
				"--configLoader",
				"runner",
			],
			false,
			guestTestDatabaseUrl,
		);
		// This suite requires its explicit disposable target as both URLs; the other
		// database suites intentionally require DATABASE_URL to be absent.
		run(
			[
				"--filter",
				"@repo/database",
				"exec",
				"vitest",
				"run",
				...isolatedVideoDatabaseTests,
				"--config",
				"vitest.integration.config.ts",
				"--configLoader",
				"runner",
			],
			true,
			videoTestDatabaseUrl,
		);
		run(
			[
				"--filter",
				"@repo/jobs",
				"exec",
				"vitest",
				"run",
				"src/handlers/finalization-transfer.database.integration.test.ts",
				"src/handlers/continuation-delivery.database.integration.test.ts",
				"src/handlers/output-review-delivery.database.integration.test.ts",
				"src/handlers/jobs.database.integration.test.ts",
				"src/handlers/legacy-engine-isolation.database.integration.test.ts",
				"src/handlers/recover-finalizing-generations.database.integration.test.ts",
				"src/handlers/verify-upload.database.integration.test.ts",
				"src/handlers/moderation-outage.database.integration.test.ts",
				"src/handlers/temporary-reference.database.integration.test.ts",
				"src/video-v1/flow.database.integration.test.ts",
				"src/video-v1/seeapi-flow.database.integration.test.ts",
				"src/video-v1/template-flow.database.integration.test.ts",
				"--config",
				"vitest.config.ts",
			],
			true,
			testDatabaseUrl,
		);
		run(
			[
				"--filter",
				"@repo/jobs",
				"exec",
				"vitest",
				"run",
				...isolatedGuestJobsTests,
				"--config",
				"vitest.config.ts",
			],
			true,
			guestTestDatabaseUrl,
		);
	}
	const isolatedApiDatabaseTests = [
		"modules/media/guest-capability.database.integration.test.ts",
		"modules/media/guest-media.integration.test.ts",
		"modules/media/guest-admission-boundary.integration.test.ts",
		"modules/media/procedures/get-guest-eligibility.database.integration.test.ts",
		"modules/media/procedures/retry-generation.database.integration.test.ts",
	] as const;
	// Real video admission counts every live legacy job against the same provider.
	// Foundation suites deliberately retain such jobs; never clear them or relax capacity.
	const isolatedVideoApiTests = [
		"modules/video-v1/veo-tiers.integration.test.ts",
		"modules/video-v1/retail-pricing.integration.test.ts",
	] as const;
	run(
		[
			"--filter",
			"@repo/api",
			"exec",
			"vitest",
			"run",
			...(phase === "api" ? [".integration.test.ts"] : []),
			...isolatedApiDatabaseTests.flatMap((test) => ["--exclude", test]),
			...isolatedVideoApiTests.flatMap((test) => ["--exclude", test]),
		],
		true,
		testDatabaseUrl,
		runtimeDatabaseAlias(testDatabaseUrl),
	);
	run(
		["--filter", "@repo/api", "exec", "vitest", "run", ...isolatedApiDatabaseTests],
		false,
		guestTestDatabaseUrl,
		runtimeDatabaseAlias(guestTestDatabaseUrl),
	);
	run(
		["--filter", "@repo/api", "exec", "vitest", "run", ...isolatedVideoApiTests],
		true,
		videoTestDatabaseUrl,
		runtimeDatabaseAlias(videoTestDatabaseUrl),
	);
	return commands;

	function run(
		args: string[],
		needsRuntimeDatabaseUrl: boolean,
		databaseUrl: string,
		runtimeDatabaseUrl?: string,
	): void {
		const environment = { ...process.env };
		environment.TEST_DATABASE_URL = databaseUrl;
		if (runtimeDatabaseUrl) environment.DATABASE_URL = runtimeDatabaseUrl;
		else if (needsRuntimeDatabaseUrl) environment.DATABASE_URL = databaseUrl;
		else delete environment.DATABASE_URL;
		commands.push({ args, environment });
	}
}

function assertDistinctDatabaseTargets(targets: URL[]): void {
	// All accepted hosts are loopback aliases. Credentials, scheme and query
	// parameters never make a second physical database on the same endpoint.
	const identities = targets.map((target) => {
		for (const key of ["host", "hostaddr", "port", "dbname", "database", "service"])
			if (target.searchParams.has(key))
				throw new Error("INTEGRATION_DATABASE_ROUTE_OVERRIDE_FORBIDDEN");
		return `${target.port || "5432"}:${decodeURIComponent(target.pathname)}`;
	});
	// Multiple forwarded ports can reach the same PostgreSQL instance. Require
	// distinct normalized database names too; ports alone cannot prove isolation.
	const databaseNames = targets.map((target) =>
		decodeURIComponent(target.pathname.slice(1)).toLowerCase(),
	);
	if (
		new Set(identities).size !== identities.length ||
		new Set(databaseNames).size !== databaseNames.length
	)
		throw new Error("INTEGRATION_DATABASE_TARGETS_MUST_BE_DISTINCT");
}

function runtimeDatabaseAlias(value: string): string {
	const url = new URL(value);
	url.searchParams.set("application_name", "ezpic-integration-runtime");
	return url.toString();
}

function execute({ args, environment }: IntegrationCommand): void {
	const command = process.platform === "win32" ? `${process.env.ComSpec ?? "cmd.exe"}` : "pnpm";
	const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", "pnpm", ...args] : args;
	const result = spawnSync(command, commandArgs, {
		cwd: process.cwd(),
		env: environment,
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	for (const command of buildIntegrationPlan(process.argv[2])) execute(command);
}
