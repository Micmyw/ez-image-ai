import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { assertCompactWorker, compactWorker } from "./compact-worker.mjs";

await test("ASCII printing preserves Unicode regexes, strings, templates and serialized functions", async () => {
	const source = [
		"const text = '中文 русский œ 😀';",
		"const regexes = [/[^a-zа-яА-ЯёЁ]+/gim, /[😀]/u, /[😀]/, /\\p{Letter}+/gu];",
		"function theme() { const mode = 'dark'; return mode; }",
		"export const sample = {text, template: `前缀 ${text}`, raw: String.raw`line\\n`, matches: regexes.map(r => text.match(r)), theme: theme.toString()};",
	].join("\n");
	const { code, map } = await compactWorker(source);
	assert.doesNotMatch(code, /[^\p{ASCII}]/u);
	const load = (value) => import(`data:text/javascript,${encodeURIComponent(value)}`);
	const before = (await load(source)).sample;
	const after = (await load(code)).sample;
	assert.deepEqual({ ...after, theme: null }, { ...before, theme: null });
	assert.equal(runInNewContext(`(${after.theme})()`), "dark");
	assert.equal(JSON.parse(map).file, "cloudflare-worker.js");
	assert(JSON.parse(map).mappings.length > 0);
});

await test("uncompacted Unicode source fails the actual artifact guard", () => {
	assert.throws(() => assertCompactWorker("const expression = /中文/u;"), /MUST_BE_ASCII/);
	assert.throws(
		() => assertCompactWorker(" ".repeat(28 * 1024 * 1024 + 1)),
		/SOURCE_MEMORY_BUDGET_EXCEEDED/,
	);
});

await test("final source maps retain the upstream source identity", async () => {
	const source = "export const result = /中文/u.test('中文');";
	const upstream = JSON.stringify({
		version: 3,
		names: [],
		sources: ["original-entry.ts"],
		sourcesContent: [source],
		mappings: "AAAA",
	});
	const { map } = await compactWorker(source, upstream);
	assert.deepEqual(JSON.parse(map).sources, ["original-entry.ts"]);
});

await test("a raw Unicode tagged template is preserved or fails closed", async () => {
	const source = "export default String.raw`中文\\n`;";
	try {
		const { code } = await compactWorker(source);
		const result = await import(`data:text/javascript,${encodeURIComponent(code)}`);
		assert.equal(result.default, "中文\\n");
	} catch (error) {
		assert.equal(error.message, "WORKER_SOURCE_MUST_BE_ASCII");
	}
});

await test("the release build packs after clearing embedded environment", async () => {
	const source = await readFile(new URL("./build.mjs", import.meta.url), "utf8");
	assert(
		source.indexOf("await packWebsiteWorker") > source.indexOf("await clearEmbeddedEnvironment"),
	);
	assert.match(source, /if \(result\.status === 0\) await packWebsiteWorker/);
});
