import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";

const app = fileURLToPath(new URL("../", import.meta.url));
const packageFile = realpathSync(
	path.join(app, "node_modules/@opennextjs/cloudflare/package.json"),
);
const require = createRequire(packageFile);
const { Lang, parse } = require("@ast-grep/napi");
const { patchCode } = await import(
	pathToFileURL(require.resolve("@opennextjs/aws/build/patch/astCodePatcher.js")).href
);
const { createComposableCacheHandlersRule } = await import(
	pathToFileURL(
		path.join(path.dirname(packageFile), "dist/cli/build/patches/plugins/next-server.js"),
	).href
);
const handlerPath = "/fixture/composable-cache.cjs";

async function verifyCacheRegistration(method) {
	const source = patchCode(
		`class CacheHost { ${method} }`,
		createComposableCacheHandlersRule(handlerPath),
	);
	const adapter = {};
	const modules = [];
	const globals = {
		process: { env: { NEXT_RUNTIME: "nodejs" } },
		require: (filename) => {
			modules.push(filename);
			assert.equal(filename, handlerPath, "Only the statically bundled adapter may load");
			return { default: adapter };
		},
	};
	const { CacheHost, readHandlers, readRegistered } = runInNewContext(
		`${source}\n({ CacheHost,
readHandlers: () => globalThis[Symbol.for("@next/cache-handlers-map")],
readRegistered: () => globalThis[Symbol.for("@next/cache-handlers-set")]
})`,
		globals,
	);
	const host = new CacheHost();
	host.nextConfig = { cacheHandlers: { default: "None", remote: "None" } };
	await host.loadCustomCacheHandlers({}, host.nextConfig);
	assert.deepEqual(modules, [handlerPath, handlerPath]);
	const handlers = readHandlers();
	assert.equal(handlers.size, 2);
	assert.equal(handlers.get("default"), adapter);
	assert.equal(handlers.get("remote"), adapter);
	const registered = readRegistered();
	assert.equal(registered.size, 1);
	assert(registered.has(adapter));
}

for (const name of ["app-route", "app-page"]) {
	await test(`installed cache patch handles Next's actual compiled ${name} aliases`, async () => {
		const source = await readFile(
			path.join(app, `node_modules/next/dist/compiled/next-server/${name}.runtime.prod.js`),
			"utf8",
		);
		const methods = parse(Lang.JavaScript, source)
			.root()
			.findAll({
				rule: {
					kind: "method_definition",
					has: { field: "name", regex: "^loadCustomCacheHandlers$" },
				},
			});
		assert.equal(methods.length, 1);
		await verifyCacheRegistration(methods[0].text());
	});
}

await test("installed cache patch retains the unminified server registration path", async () => {
	await verifyCacheRegistration(`
async loadCustomCacheHandlers() {
  const { cacheHandlers } = this.nextConfig;
  if (!cacheHandlers) return;
  throw new Error("Configured handler paths must not load dynamically in workerd");
}
`);
});
