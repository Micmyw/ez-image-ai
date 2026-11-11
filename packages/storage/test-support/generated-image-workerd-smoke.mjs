import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = path.join(root, ".wrangler/generated-image-smoke");
const require = createRequire(
	realpathSync(path.join(root, "apps/workflows/node_modules/wrangler/package.json")),
);
const storageRequire = createRequire(path.join(root, "packages/storage/package.json"));
const { build, stop } = require("esbuild");
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const sharp = storageRequire("sharp");
await mkdir(output, { recursive: true });
const wasm = storageRequire.resolve("@resvg/resvg-wasm/index_bg.wasm");
await copyFile(wasm, path.join(output, "svg.wasm"));
const built = await build({
	stdin: {
		contents: `export default { async fetch(request) { const { svgReviewPng, gifReviewPng } = await import(${JSON.stringify(path.join(root, "packages/storage/image-processing/generated-image-review.ts"))}); const bytes = new Uint8Array(await request.arrayBuffer()); try { const png = request.headers.get('content-type') === 'image/gif' ? gifReviewPng(bytes) : await svgReviewPng(bytes); return new Response(png, { headers: { 'content-type': 'image/png' } }); } catch(error) { return Response.json({code: error.code, message: error.message}, {status: 422}); } } };`,
		resolveDir: root,
		sourcefile: "generated-image-smoke.ts",
		loader: "ts",
	},
	bundle: true,
	format: "esm",
	platform: "neutral",
	conditions: ["workerd"],
	mainFields: ["module", "main"],
	external: ["node:*"],
	write: false,
	plugins: [
		{
			name: "compiled-svg-wasm",
			setup(builder) {
				builder.onResolve({ filter: /index_bg\.wasm$/ }, () => ({
					path: "./svg.wasm",
					external: true,
				}));
			},
		},
	],
});
const script = built.outputFiles[0].text;
assert(!script.includes("readFile"), "Node WASM loader must not enter Workers");
await writeFile(path.join(output, "worker.mjs"), script);
stop();
const runtime = new Miniflare(
	convertV4MiniflareOptions({
		modulesRoot: output,
		compatibilityDate: "2026-09-10",
		compatibilityFlags: ["nodejs_compat"],
		modules: [
			{ type: "ESModule", path: path.join(output, "worker.mjs") },
			{ type: "CompiledWasm", path: path.join(output, "svg.wasm") },
		],
	}),
);
process.stdout.write(`Generated-image smoke launcher PID ${process.pid}\n`);
try {
	const source =
		'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="red"/></svg>';
	const svg = await runtime.dispatchFetch("http://fixture.test/svg", {
		method: "POST",
		body: source,
	});
	assert.equal(svg.status, 200);
	const bytes = Buffer.from(await svg.arrayBuffer());
	assert.deepEqual(
		await sharp(bytes)
			.metadata()
			.then(({ width, height }) => ({ width, height })),
		{ width: 1568, height: 784 },
	);
	const invalid = await runtime.dispatchFetch("http://fixture.test/svg", {
		method: "POST",
		body: source.replace("<rect", "<script>alert(1)</script><rect"),
	});
	assert.equal(invalid.status, 422);
	const animated = await sharp(Buffer.from([255, 0, 0, 0, 0, 255]), {
		raw: { width: 1, height: 2, channels: 3, pageHeight: 1 },
	})
		.gif({ loop: 0, delay: [200, 200] })
		.toBuffer();
	const gif = await runtime.dispatchFetch("http://fixture.test/gif", {
		method: "POST",
		headers: { "content-type": "image/gif" },
		body: animated,
	});
	assert.equal(gif.status, 200);
	const pixels = await sharp(Buffer.from(await gif.arrayBuffer()))
		.raw()
		.toBuffer();
	for (const [x, color] of [
		[392, [255, 0, 0]],
		[1176, [0, 0, 255]],
	]) {
		const offset = (784 * 1568 + x) * 4;
		assert.deepEqual([...pixels.subarray(offset, offset + 3)], color);
	}
	console.log(
		"Workers SVG WASM rendering, active-content rejection and all-frame GIF review passed",
	);
} finally {
	await runtime.dispose();
}
