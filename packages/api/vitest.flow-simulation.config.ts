import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { defineConfig, mergeConfig } from "vitest/config";

import config from "./vitest.config";

// Replay the saved timing-only source without moving HEAD or modifying the checkout.
export default mergeConfig(
	config,
	defineConfig({
		plugins: [
			{
				name: "timing-only-status-baseline",
				enforce: "pre",
				transform(_source, id) {
					if (process.env.FLOW_STATUS_BASELINE !== "1") return;
					const relative = id.replaceAll("\\", "/").split("/packages/api/")[1];
					if (
						![
							"modules/media/procedures/get-job.ts",
							"modules/media/procedures/get-asset-access-url.ts",
						].includes(relative)
					)
						return;
					const filename = resolve(
						process.cwd(),
						"../../tooling/e2e/fixtures/generation-batch1/timing-only/packages/api",
						`${relative}.txt`,
					);
					return { code: readFileSync(filename, "utf8"), map: null };
				},
			},
		],
	}),
);
