import { spawnSync } from "node:child_process";

import { assertSafeDatabaseUrl } from "./assert-safe-target";

const testDatabaseUrl = assertSafeDatabaseUrl(process.env.TEST_DATABASE_URL).toString();
const guestTestDatabaseUrl = assertSafeDatabaseUrl(
	process.env.GUEST_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL,
).toString();
const isolatedGuestDatabaseTests = [
	"prisma/queries/media/anonymous-standard-schema.integration.test.ts",
	"prisma/queries/media/guest-admission.integration.test.ts",
	"prisma/queries/media/guest-bootstrap.integration.test.ts",
	"prisma/queries/media/guest-link.integration.test.ts",
	"prisma/queries/media/guest-retention.integration.test.ts",
] as const;

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
run(
	[
		"--filter",
		"@repo/jobs",
		"exec",
		"vitest",
		"run",
		"src/handlers/jobs.database.integration.test.ts",
		"src/handlers/finalization-transfer.database.integration.test.ts",
		"src/handlers/runtime-stores.database.integration.test.ts",
		"src/handlers/verify-upload.database.integration.test.ts",
		"--config",
		"vitest.config.ts",
	],
	true,
	testDatabaseUrl,
);
const isolatedApiDatabaseTests = [
	"modules/media/guest-capability.database.integration.test.ts",
	"modules/media/guest-media.integration.test.ts",
	"modules/media/guest-admission-boundary.integration.test.ts",
	"modules/media/procedures/get-guest-eligibility.database.integration.test.ts",
	"modules/media/procedures/retry-generation.database.integration.test.ts",
] as const;
run(
	[
		"--filter",
		"@repo/api",
		"exec",
		"vitest",
		"run",
		...isolatedApiDatabaseTests.flatMap((test) => ["--exclude", test]),
	],
	true,
	testDatabaseUrl,
);
run(
	["--filter", "@repo/api", "exec", "vitest", "run", ...isolatedApiDatabaseTests],
	false,
	testDatabaseUrl,
	runtimeDatabaseAlias(testDatabaseUrl),
);

function runtimeDatabaseAlias(value: string): string {
	const url = new URL(value);
	url.searchParams.set("application_name", "ezpic-integration-runtime");
	return url.toString();
}

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
