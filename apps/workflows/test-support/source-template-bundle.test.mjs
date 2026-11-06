import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(appRoot, "../..");
const require = createRequire(path.join(appRoot, "package.json"));
const wranglerRoot = path.dirname(require.resolve("wrangler/package.json"));

await test("the real Jobs Worker consumes frozen source templates without offline archives or prompt builders", (t) => {
	const cacheRoot = path.join(repoRoot, ".cache", "source-template-bundle-test");
	mkdirSync(cacheRoot, { recursive: true });
	const directory = mkdtempSync(path.join(cacheRoot, "case-"));
	try {
		const envFile = path.join(directory, "empty.env");
		const metafile = path.join(directory, "bundle.meta.json");
		writeFileSync(envFile, "");
		const result = spawnSync(
			process.execPath,
			[
				path.join(wranglerRoot, "bin", "wrangler.js"),
				"deploy",
				"--config",
				"wrangler.workers.jsonc",
				"--env-file",
				envFile,
				"--dry-run",
				"--minify",
				"--metafile",
				metafile,
				"--outdir",
				path.join(directory, "output"),
				"--no-autoconfig",
			],
			{
				cwd: appRoot,
				windowsHide: true,
				encoding: "utf8",
				maxBuffer: 4 * 1024 * 1024,
				env: {
					...process.env,
					WRANGLER_SEND_METRICS: "false",
					CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
				},
			},
		);
		assert.equal(result.status, 0, result.stderr || result.error?.message);
		const worker = readFileSync(path.join(directory, "output", "workers.js"));
		t.diagnostic(
			`Jobs Worker JavaScript: ${worker.length} bytes; gzip: ${gzipSync(worker).length} bytes`,
		);
		const uploadSummary = result.stdout.match(/Total Upload:[^\r\n]+/)?.[0];
		if (uploadSummary) t.diagnostic(uploadSummary);
		const metadata = JSON.parse(readFileSync(metafile, "utf8"));
		const inputs = Object.keys(metadata.inputs);
		assert.deepEqual(
			inputs.filter((input) =>
				/rap-templates\/(?:archive\.ts|source-manifest\.json|original-template-configs\.json|private-assets\/)|rap-templates\/contracts\.ts|rap-templates\/source\/flyingcar\/templates\/prompts\.json|jobs\/src\/video-v1\/source-template-admission\.ts/.test(
					input.replaceAll("\\", "/"),
				),
			),
			[],
		);
		const contributions = Object.values(metadata.outputs).flatMap((output) =>
			Object.entries(output.inputs ?? {}),
		);
		for (const required of [
			"packages/ai/media/rap-templates/transport.ts",
			"packages/jobs/src/video-v1/source-template-review.ts",
		])
			assert.ok(
				contributions.some(([input, value]) => input.endsWith(required) && value.bytesInOutput > 0),
				`Missing runtime consumer: ${required}`,
			);
	} finally {
		const relative = path.relative(cacheRoot, directory);
		assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
		rmSync(directory, { recursive: true });
	}
});
