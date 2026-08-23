import { spawnSync } from "node:child_process";

import { assertSafeDatabaseUrl } from "./assert-safe-target";

const testDatabaseUrl = assertSafeDatabaseUrl(process.env.TEST_DATABASE_URL).toString();
const commands: Array<{ args: string[]; database: boolean }> = [
	{ args: ["--filter", "@repo/config", "test"], database: false },
	{ args: ["--filter", "@repo/ai", "test"], database: false },
	{ args: ["--filter", "@repo/storage", "test"], database: false },
	{ args: ["--filter", "@repo/payments", "test"], database: false },
	{ args: ["--filter", "@repo/database", "test"], database: false },
	{ args: ["--filter", "@repo/jobs", "test"], database: false },
	{
		args: [
			"--filter",
			"@repo/api",
			"exec",
			"vitest",
			"run",
			"--exclude",
			"**/*.integration.test.ts",
		],
		database: true,
	},
	{ args: ["--filter", "saas", "test"], database: true },
	{ args: ["--filter", "marketing", "test"], database: false },
];

for (const command of commands) run(command.args, command.database);

function run(args: string[], needsRuntimeDatabaseUrl: boolean): void {
	const environment = { ...process.env };
	if (needsRuntimeDatabaseUrl) environment.DATABASE_URL = testDatabaseUrl;
	else delete environment.DATABASE_URL;
	const executable = process.platform === "win32" ? `${process.env.ComSpec ?? "cmd.exe"}` : "pnpm";
	const executableArgs = process.platform === "win32" ? ["/d", "/s", "/c", "pnpm", ...args] : args;
	const result = spawnSync(executable, executableArgs, {
		cwd: process.cwd(),
		env: environment,
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}
