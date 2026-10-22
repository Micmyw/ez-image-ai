import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

assert.equal(typeof globalThis.gc, "function", "Run the isolated ownership check with --expose-gc");
const entrypoint = process.argv[2];
assert(["esm", "cjs"].includes(entrypoint));
const require = createRequire(import.meta.url);
const runtime = path.dirname(require.resolve("@prisma/client/runtime/wasm-compiler-edge"));
const helperPath = path.join(
	runtime,
	`query-compiler-reuse.${entrypoint === "esm" ? "mjs" : "js"}`,
);
const helper =
	entrypoint === "esm" ? await import(pathToFileURL(helperPath).href) : require(helperPath);

const references = [];
const NativeFinalizationRegistry = globalThis.FinalizationRegistry;
let finalizerCalls = 0;
let unregisterCalls = 0;
globalThis.FinalizationRegistry = class extends NativeFinalizationRegistry {
	constructor(callback) {
		super((held) => {
			finalizerCalls++;
			callback(held);
		});
	}
	register(target, held, token) {
		references.push(new WeakRef(target));
		return super.register(target, held, token);
	}
	unregister(token) {
		unregisterCalls++;
		return super.unregister(token);
	}
};
let glue;
try {
	glue = await import(
		pathToFileURL(path.join(runtime, "query_compiler_fast_bg.postgresql.mjs")).href
	);
} finally {
	globalThis.FinalizationRegistry = NativeFinalizationRegistry;
}
const wasmPath = fileURLToPath(
	new URL("../prisma/generated-worker/internal/query_compiler_fast_bg.wasm", import.meta.url),
);
const module = new WebAssembly.Module(await readFile(wasmPath));
const instance = new WebAssembly.Instance(module, { "./query_compiler_fast_bg.js": glue });
glue.__wbg_set_wasm(instance.exports);
instance.exports.__wbindgen_start();
const Constructor = glue.QueryCompiler;
const originalFree = Constructor.prototype.free;
let freeCalls = 0;
Constructor.prototype.free = function () {
	freeCalls++;
	return originalFree.call(this);
};
const options = {
	datamodel:
		'datasource db {\n provider = "postgresql"\n}\nmodel CacheProbe {\n id Int @id\n owner String\n}',
	provider: "postgres",
	connectionInfo: { schemaName: "public", supportsRelationJoins: true },
};
const query = (owner, selection = { id: true, owner: true }) =>
	JSON.stringify({
		modelName: "CacheProbe",
		action: "findMany",
		query: { arguments: { where: { owner } }, selection },
	});
async function collect() {
	for (let index = 0; index < 8; index++) {
		await setImmediate();
		globalThis.gc();
	}
	await setImmediate();
}

let first = helper.createReusableQueryCompiler(Constructor, options);
let second = helper.createReusableQueryCompiler(Constructor, {
	...options,
	connectionInfo: { ...options.connectionInfo },
});
assert.equal(references.length, 1, "The real WASM constructor must execute exactly once");
let left = first.compile(query("alice"));
let right = second.compile(query("bob"));
assert.notDeepEqual(left, right, "Real query plans must retain each query's distinct parameters");
const planReferences = [new WeakRef(left), new WeakRef(right)];
left = undefined;
right = undefined;
let sentinel = { unretainedControl: true };
const control = new WeakRef(sentinel);
sentinel = undefined;
first.free();
first = undefined;
await collect();
assert.equal(control.deref(), undefined, "The unretained GC control must be collected");
assert(
	planReferences.every((reference) => reference.deref() === undefined),
	"The cache must not retain returned JS query plans",
);
assert(
	references[0].deref()?.__wbg_ptr > 0,
	"A live shared compiler must not be finalized when one facade closes",
);
assert.equal(freeCalls, 0);
assert.equal(unregisterCalls, 0);
second.compile(query("after-client-disconnect"));

let validation;
try {
	second.compile(query("invalid", { unknownField: true }));
} catch (error) {
	validation = error;
}
assert(validation, "The real compiler must reject the unknown model field");
helper.hardDisableQueryCompilerReuse(Constructor);
second.free();
second = undefined;
await collect();
assert(
	references[0].deref()?.__wbg_ptr > 0,
	"Quarantine must strongly retain the real glue object after all facades close",
);
assert.equal(freeCalls, 0, "Quarantined WASM must not be explicitly freed");
assert.equal(finalizerCalls, 0, "Quarantined WASM must not reach FinalizationRegistry cleanup");

for (let index = 0; index < 4; index++) {
	let independent = helper.createReusableQueryCompiler(Constructor, options);
	independent.compile(query(`independent-${index}`));
	independent.free();
	independent = undefined;
}
assert.equal(references.length, 5, "Disabled reuse must construct independent future clients");
assert.equal(freeCalls, 4, "Independent successful instances must keep their normal ownership");
assert.equal(unregisterCalls, 4);
await collect();
assert(
	references.slice(1).every((reference) => reference.deref() === undefined),
	"Quarantine must not retain later independent clients",
);
assert(references[0].deref()?.__wbg_ptr > 0);
process.stdout.write(
	JSON.stringify({
		passed: true,
		entrypoint,
		realCompiler: true,
		rootPid: process.pid,
		parentPid: process.ppid,
		gcControlCollected: true,
		cachedCompilerCount: 1,
		quarantinedCompilerCount: 1,
		independentCompilerCount: 4,
		explicitFrees: freeCalls,
		finalizerCalls,
		validationShape: {
			plain: Object.getPrototypeOf(validation) === Object.prototype,
			ownKeys: Reflect.ownKeys(validation).map(String),
			dataPropertiesOnly: Object.values(Object.getOwnPropertyDescriptors(validation)).every(
				(descriptor) => "value" in descriptor,
			),
			code: validation.code,
			meta: validation.meta,
		},
	}) + "\n",
);
