import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { resolvePrecompiledWasmExternal } from "./wasm-external.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const storage = path.resolve(root, "packages/storage/image-processing");
const require = createRequire(import.meta.url);

await test("preserves Prisma relative modules and externalizes only the known SVG module", () => {
	assert.equal(
		resolvePrecompiledWasmExternal({ context: storage, request: "./compiler.wasm?module" }),
		path.join(storage, "compiler.wasm?module"),
	);
	assert.match(
		resolvePrecompiledWasmExternal({
			context: storage,
			request: "@resvg/resvg-wasm/index_bg.wasm",
		}),
		/index_bg\.wasm\?module$/,
	);
	assert.equal(
		resolvePrecompiledWasmExternal({ context: storage, request: "unrelated.wasm" }),
		undefined,
	);
});

await test("Next's real Webpack compiles the Workers SVG module as a precompiled external", async () => {
	const bundled = require("next/dist/compiled/webpack/webpack");
	const { webpack, ExternalsPlugin } = bundled;
	const temporary = await mkdtemp(path.join(tmpdir(), "ezpic-svg-webpack-"));
	let compiler;
	try {
		const entry = path.join(temporary, "entry.js");
		await writeFile(
			entry,
			`export { svgWasm } from ${JSON.stringify(path.join(storage, "svg-wasm-worker.ts"))};`,
		);
		compiler = webpack({
			mode: "production",
			target: "webworker",
			entry,
			optimization: { minimize: false },
			experiments: { outputModule: true },
			output: { path: temporary, filename: "compiled.mjs", library: { type: "module" } },
			plugins: [
				new ExternalsPlugin("import", (data, callback) =>
					callback(undefined, resolvePrecompiledWasmExternal(data)),
				),
			],
		});
		const stats = await new Promise((resolve, reject) =>
			compiler.run((error, result) => (error ? reject(error) : resolve(result))),
		);
		assert.equal(stats.hasErrors(), false, stats.toString({ all: false, errors: true }));
		const compiled = await readFile(path.join(temporary, "compiled.mjs"), "utf8");
		assert.match(compiled, /index_bg\.wasm\?module/);
		assert(
			!compiled.includes("WebAssembly.instantiate"),
			"Webpack must not inline a runtime WASM loader",
		);
	} finally {
		if (compiler)
			await new Promise((resolve, reject) =>
				compiler.close((error) => (error ? reject(error) : resolve())),
			);
		assert(
			path.dirname(temporary) === tmpdir() &&
				path.basename(temporary).startsWith("ezpic-svg-webpack-"),
		);
		await rm(temporary, { recursive: true });
	}
});
