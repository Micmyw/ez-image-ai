import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const run = promisify(execFile);

// Keep workerd in its own process and include its source-bundle regression in SaaS/CI tests.
it("runs the isolated workerd request lifetime regression", async () => {
	const { stdout } = await run(
		process.execPath,
		["--test", path.join(import.meta.dirname, "request-scope.workerd.test.mjs")],
		{ timeout: 30_000 },
	);
	expect(stdout).toContain("source bundles keep short wakes and derived work");
}, 35_000);
