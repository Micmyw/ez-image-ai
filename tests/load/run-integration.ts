import { spawnSync } from "node:child_process";

import { assertSafeDatabaseUrl } from "./assert-safe-target";

const testDatabaseUrl = assertSafeDatabaseUrl(process.env.TEST_DATABASE_URL).toString();

run(["--filter", "@repo/database", "test:integration"], false);
run(
	[
		"--filter",
		"@repo/jobs",
		"exec",
		"vitest",
		"run",
		"src/handlers/jobs.database.integration.test.ts",
		"src/handlers/runtime-stores.database.integration.test.ts",
		"src/handlers/verify-upload.database.integration.test.ts",
		"--config",
		"vitest.config.ts",
	],
	true,
);
run(["--filter", "@repo/api", "test"], true);

function run(args: string[], needsRuntimeDatabaseUrl: boolean): void {
	const environment = { ...process.env };
	if (needsRuntimeDatabaseUrl) environment.DATABASE_URL = testDatabaseUrl;
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
