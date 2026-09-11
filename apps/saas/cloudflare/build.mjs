import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { clearEmbeddedEnvironment } from "./artifact-safety.mjs";

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageManager = process.env.npm_execpath;
if (!packageManager) throw new Error("RUN_CLOUDFLARE_BUILD_WITH_PNPM");

const result = spawnSync(
	process.execPath,
	[packageManager, "exec", "opennextjs-cloudflare", "build", ...process.argv.slice(2)],
	{
		cwd: appDirectory,
		stdio: "inherit",
		env: {
			...process.env,
			NODE_ENV: "production",
			EZPIC_RUNTIME: "node",
			EZPIC_WORKERS_BUILD: "true",
			CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
		},
	},
);
await clearEmbeddedEnvironment(appDirectory, { requireOutput: result.status === 0 });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
