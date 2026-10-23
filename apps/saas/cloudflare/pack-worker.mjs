import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compactWorker } from "./compact-worker.mjs";

export async function packWebsiteWorker(appDirectory, packageManager = process.env.npm_execpath) {
	if (!packageManager) throw new Error("RUN_CLOUDFLARE_BUILD_WITH_PNPM");
	const dist = path.resolve(appDirectory, "dist");
	await mkdir(dist, { recursive: true });
	const staging = await mkdtemp(path.join(dist, "worker-pack-"));
	const output = path.join(dist, "worker");
	if (path.dirname(output) !== dist || path.dirname(staging) !== dist)
		throw new Error("WORKER_OUTPUT_BOUNDARY_INVALID");
	try {
		const bundled = spawnSync(
			process.execPath,
			[
				packageManager,
				"exec",
				"wrangler",
				"deploy",
				"--dry-run",
				"--minify",
				"--outdir",
				staging,
				"--metafile",
				path.join(staging, "bundle-meta.json"),
			],
			{
				cwd: appDirectory,
				stdio: "inherit",
				env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" },
			},
		);
		if (bundled.error) throw bundled.error;
		if (bundled.status !== 0) throw new Error("WEBSITE_WORKER_BUNDLE_FAILED");
		const filename = path.join(staging, "cloudflare-worker.js");
		const source = await readFile(filename, "utf8");
		const sourceMap = await readFile(`${filename}.map`, "utf8");
		const compact = await compactWorker(source, sourceMap);
		await writeFile(filename, compact.code);
		await writeFile(`${filename}.map`, compact.map);
		// Replace only this build's fixed output directory. Never follow a caller's
		// arbitrary cleanup path; dependencies, source and previous evidence stay put.
		await rm(output, { recursive: true, force: true });
		await rename(staging, output);
		console.log(`Packed ASCII website Worker: ${Buffer.byteLength(compact.code)} bytes`);
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await packWebsiteWorker(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
}
