import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
	compilerFixture,
	compilerOptions,
	type CompilerFacade,
	type CompilerOptions,
	type ReuseCompiler,
} from "../test-support/query-compiler-cache-fixture";

const require = createRequire(import.meta.url);
const runtimeDirectory = path.dirname(require.resolve("@prisma/client/runtime/wasm-compiler-edge"));
const esm = (await import(
	pathToFileURL(path.join(runtimeDirectory, "query-compiler-reuse.mjs")).href
)) as {
	createReusableQueryCompiler: ReuseCompiler;
	hardDisableQueryCompilerReuse: (constructor: Parameters<ReuseCompiler>[0]) => void;
};
const cjs = require(path.join(runtimeDirectory, "query-compiler-reuse.js")) as typeof esm;

it("uses the same cache core when CJS and ESM entrypoints coexist", () => {
	expect(esm.createReusableQueryCompiler).toBe(cjs.createReusableQueryCompiler);
	expect(esm.hardDisableQueryCompilerReuse).toBe(cjs.hardDisableQueryCompilerReuse);
	const { Compiler, state } = compilerFixture();
	const first = esm.createReusableQueryCompiler(Compiler, compilerOptions());
	const second = cjs.createReusableQueryCompiler(Compiler, compilerOptions());
	expect(state.constructAttempts).toBe(1);
	expect(first.compile("esm")).toMatchObject({ compilerId: 1 });
	expect(second.compile("cjs")).toMatchObject({ compilerId: 1 });
	first.free();
	second.free();
	expect(state.freeAttempts).toBe(0);
});

describe.each([
	["ESM", esm],
	["CJS", cjs],
] as const)("installed Prisma compiler borrowing (%s)", (_entrypoint, helper) => {
	const create = helper.createReusableQueryCompiler;
	it("returns distinct facades and fresh plans without retaining another client's parameters", () => {
		const { Compiler, state } = compilerFixture();
		const first = create(Compiler, compilerOptions());
		const second = create(Compiler, compilerOptions());
		expect(first).not.toBe(second);
		expect(state.constructAttempts).toBe(1);
		const firstPlan = first.compile("owner=alice; projection=id");
		const secondPlan = second.compile("owner=bob; projection=owner,width");
		expect(firstPlan).toMatchObject({ compilerId: 1, query: "owner=alice; projection=id" });
		expect(secondPlan).toMatchObject({ compilerId: 1, query: "owner=bob; projection=owner,width" });
		expect(firstPlan).not.toBe(secondPlan);
		(firstPlan as { plan: { method: string } }).plan.method = "client-local-mutation";
		expect(secondPlan).toMatchObject({ plan: { method: "single" } });
		expect(second.compileBatch("owner=bob; batch=two")).toMatchObject({
			compilerId: 1,
			query: "owner=bob; batch=two",
		});
		first.free();
		expect(state.freeAttempts).toBe(0);
		expect(second.compile("still-live")).toMatchObject({ compilerId: 1, query: "still-live" });
		second.free();
		expect(state.useAfterFree).toBe(0);
		expect(state.freeAttempts).toBe(0);
	});

	it.each([
		[
			"datamodel",
			(o: CompilerOptions) => {
				o.datamodel += " // changed";
			},
		],
		[
			"provider",
			(o: CompilerOptions) => {
				o.provider = "cockroachdb";
			},
		],
		[
			"schemaName",
			(o: CompilerOptions) => {
				o.connectionInfo.schemaName = "tenant_two";
			},
		],
		[
			"maxBindValues",
			(o: CompilerOptions) => {
				o.connectionInfo.maxBindValues = 17;
			},
		],
		[
			"supportsRelationJoins",
			(o: CompilerOptions) => {
				o.connectionInfo.supportsRelationJoins = false;
			},
		],
	] as const)("never borrows a compiler for a different %s", (_field, change) => {
		const { Compiler, state } = compilerFixture();
		const first = create(Compiler, compilerOptions());
		const changed = compilerOptions();
		change(changed);
		const other = create(Compiler, changed);
		expect(other.compile("other-key")).toMatchObject({ compilerId: 2 });
		other.free();
		expect(state.instances[1]?.freed).toBe(true);
		expect(first.compile("original-key")).toMatchObject({ compilerId: 1 });
		first.free();
		expect(state.instances[0]?.freed).toBe(false);
	});

	it.each(["schemaName", "maxBindValues", "supportsRelationJoins"] as const)(
		"distinguishes absent, undefined and present %s options",
		(field) => {
			const { Compiler, state } = compilerFixture();
			const absent = compilerOptions();
			delete absent.connectionInfo[field];
			const first = create(Compiler, absent);
			const undefinedValue = compilerOptions();
			Object.defineProperty(undefinedValue.connectionInfo, field, {
				value: undefined,
				enumerable: true,
			});
			const second = create(Compiler, undefinedValue);
			const third = create(Compiler, compilerOptions());
			expect(state.constructAttempts).toBe(3);
			for (const facade of [first, second, third]) facade.free();
		},
	);

	it("rejects unknown top-level, connection, symbol and accessor shapes from sharing", () => {
		const { Compiler, state } = compilerFixture();
		const first = create(Compiler, compilerOptions());
		let getterReads = 0;
		const shapes = [
			Object.assign(compilerOptions(), { futureTopLevelOption: true }),
			{
				...compilerOptions(),
				connectionInfo: { ...compilerOptions().connectionInfo, futureCapability: true },
			},
			Object.assign(compilerOptions(), { [Symbol("future")]: true }),
			{
				...compilerOptions(),
				connectionInfo: Object.assign(compilerOptions().connectionInfo, {
					[Symbol("future")]: true,
				}),
			},
			Object.defineProperty(compilerOptions(), "provider", {
				get() {
					getterReads++;
					return "postgresql";
				},
			}),
			{
				...compilerOptions(),
				connectionInfo: Object.defineProperty(compilerOptions().connectionInfo, "schemaName", {
					get() {
						getterReads++;
						return "public";
					},
				}),
			},
			{
				...compilerOptions(),
				connectionInfo: Object.assign(
					Object.create({ inherited: true }),
					compilerOptions().connectionInfo,
				),
			},
			Object.assign(Object.create({ inherited: true }), compilerOptions()),
		];
		for (const options of shapes) {
			const one = create(Compiler, options);
			const two = create(Compiler, options);
			one.free();
			two.free();
		}
		expect(state.constructAttempts).toBe(1 + shapes.length * 2);
		expect(getterReads).toBe(0);
		expect(first.compile("safe-original")).toMatchObject({ compilerId: 1 });
		first.free();
	});

	it("does not let caller mutation turn one cached options tuple into another", () => {
		const { Compiler, state } = compilerFixture();
		const options = compilerOptions();
		const first = create(Compiler, options);
		options.connectionInfo.schemaName = "mutated_schema";
		options.datamodel += " // mutation";
		const second = create(Compiler, options);
		expect(state.constructAttempts).toBe(2);
		expect(second.compile("mutated")).toMatchObject({ compilerId: 2 });
		const original = create(Compiler, compilerOptions());
		expect(original.compile("original")).toMatchObject({ compilerId: 1 });
		for (const facade of [first, second, original]) facade.free();
	});

	it("allows synchronous reentry using a private compiler without waiting or reusing the busy one", () => {
		let second!: CompilerFacade;
		let nested: unknown;
		const { Compiler, state } = compilerFixture({
			compile(_instance, query) {
				if (query === "outer") nested = second.compileBatch("nested");
			},
		});
		const first = create(Compiler, compilerOptions());
		second = create(Compiler, compilerOptions());
		expect(first.compile("outer")).toMatchObject({ compilerId: 1 });
		expect(nested).toMatchObject({ compilerId: 2, query: "nested" });
		expect(state.constructAttempts).toBe(2);
		expect(second.compile("after-reentry")).toMatchObject({ compilerId: 1 });
		first.free();
		second.free();
		expect(state.instances[0]?.freed).toBe(false);
		expect(state.instances[1]?.freed).toBe(true);
	});

	it("handles construction during a borrow with an independent eager instance", () => {
		let nested!: CompilerFacade;
		const { Compiler, state } = compilerFixture({
			compile(_instance, query) {
				if (query === "outer") nested = create(Compiler, compilerOptions());
			},
		});
		const first = create(Compiler, compilerOptions());
		first.compile("outer");
		expect(state.constructAttempts).toBe(2);
		expect(nested.compile("nested-client")).toMatchObject({ compilerId: 2 });
		nested.free();
		first.free();
		expect(state.instances[1]?.freed).toBe(true);
		expect(state.instances[0]?.freed).toBe(false);
	});

	it("does not publish a half-constructed cached instance during constructor reentry", () => {
		let nested!: CompilerFacade;
		const { Compiler, state } = compilerFixture({
			construct(_options, attempt) {
				if (attempt === 1) nested = create(Compiler, compilerOptions());
			},
		});
		const first = create(Compiler, compilerOptions());
		expect(state.constructAttempts).toBe(2);
		expect(first.compile("outer-client")).toMatchObject({ compilerId: 1 });
		expect(nested.compile("constructor-child")).toMatchObject({ compilerId: 2 });
		nested.free();
		first.free();
	});

	it("quarantines both active compiler objects when a reentrant private compile throws", () => {
		const failure = new Error("EXPECTED_NESTED_COMPILER_FAILURE");
		let second!: CompilerFacade;
		const { Compiler, state } = compilerFixture({
			compile(_instance, query) {
				if (query === "outer") second.compile("inner");
				if (query === "inner") throw failure;
			},
		});
		const first = create(Compiler, compilerOptions());
		second = create(Compiler, compilerOptions());
		expect(() => first.compile("outer")).toThrow(failure);
		expect(state.constructAttempts).toBe(2);
		expect(state.compileCalls).toBe(2);
		first.free();
		second.free();
		expect(state.freeAttempts).toBe(0);
		expect(state.instances.every((instance) => !instance.freed)).toBe(true);
	});

	it("defers a reentrant private free until its active compile has returned", () => {
		let privateFacade!: CompilerFacade;
		let compiling = false;
		const { Compiler, state } = compilerFixture({
			compile(_instance, query) {
				if (query === "close-self") {
					compiling = true;
					privateFacade.free();
					expect(state.freeAttempts).toBe(0);
					compiling = false;
				}
			},
			free() {
				expect(compiling).toBe(false);
			},
		});
		const cached = create(Compiler, compilerOptions());
		const other = compilerOptions();
		other.connectionInfo.schemaName = "private";
		privateFacade = create(Compiler, other);
		privateFacade.compile("close-self");
		expect(state.freeAttempts).toBe(1);
		expect(() => privateFacade.compile("closed")).toThrow("QUERY_COMPILER_FACADE_CLOSED");
		privateFacade.free();
		cached.free();
		expect(state.freeAttempts).toBe(1);
	});

	it.each(["compile", "compileBatch"] as const)(
		"disables a constructor on %s failure, quarantines the raw compiler and never retries",
		(method) => {
			const failure = new Error("EXPECTED_COMPILER_FAILURE");
			const hooks = {
				[method]: (_instance: unknown, query: string) => {
					if (query === "bad") throw failure;
				},
			};
			const { Compiler, state } = compilerFixture(hooks);
			const first = create(Compiler, compilerOptions());
			const second = create(Compiler, compilerOptions());
			expect(() => first[method]("bad")).toThrow(failure);
			expect(state.compileCalls + state.batchCalls).toBe(1);
			expect(state.constructAttempts).toBe(1);
			expect(() => second.compile("must-not-retry")).toThrow("QUERY_COMPILER_REUSE_DISABLED");
			first.free();
			second.free();
			expect(state.freeAttempts).toBe(0);
			const third = create(Compiler, compilerOptions());
			const fourth = create(Compiler, compilerOptions());
			expect(state.constructAttempts).toBe(3);
			expect(third.compile("new-independent")).toMatchObject({ compilerId: 2 });
			third.free();
			fourth.free();
			expect(state.instances[0]?.freed).toBe(false);
		},
	);

	it("disables reuse after initial construction fails and preserves the original error", () => {
		const failure = new Error("EXPECTED_CONSTRUCTOR_FAILURE");
		const { Compiler, state } = compilerFixture({
			construct(_options, attempt) {
				if (attempt === 1) throw failure;
			},
		});
		expect(() => create(Compiler, compilerOptions())).toThrow(failure);
		const second = create(Compiler, compilerOptions());
		const third = create(Compiler, compilerOptions());
		expect(state.constructAttempts).toBe(3);
		second.free();
		third.free();
		expect(state.freeAttempts).toBe(2);
	});

	it("quarantines the cached compiler when construction for a different tuple fails", () => {
		const failure = new Error("EXPECTED_OTHER_KEY_CONSTRUCTOR_FAILURE");
		const { Compiler, state } = compilerFixture({
			construct(_options, attempt) {
				if (attempt === 2) throw failure;
			},
		});
		const first = create(Compiler, compilerOptions());
		const other = compilerOptions();
		other.connectionInfo.schemaName = "other";
		expect(() => create(Compiler, other)).toThrow(failure);
		expect(() => first.compile("must-not-revive")).toThrow("QUERY_COMPILER_REUSE_DISABLED");
		first.free();
		expect(state.freeAttempts).toBe(0);
	});

	it("transforms a reentrant constructor error once without retrying or freeing poisoned objects", () => {
		const original = new Error("EXPECTED_REENTRANT_INIT_FAILURE");
		const transformed = new Error("TRANSFORMED_INITIALIZATION_ERROR");
		let transformations = 0;
		let nested!: CompilerFacade;
		const { Compiler, state } = compilerFixture({
			construct(_options, attempt) {
				if (attempt === 2) throw original;
			},
			compile(_instance, query) {
				if (query === "outer") nested.compile("nested");
			},
		});
		const first = create(Compiler, compilerOptions());
		nested = create(Compiler, compilerOptions(), (error) => {
			expect(error).toBe(original);
			transformations++;
			return transformed;
		});
		expect(() => first.compile("outer")).toThrow(transformed);
		expect(transformations).toBe(1);
		expect(state.constructAttempts).toBe(2);
		expect(state.compileCalls).toBe(1);
		first.free();
		nested.free();
		expect(state.freeAttempts).toBe(0);
	});

	it("invalidates the cached epoch on an independent compiler's compile or free failure", () => {
		for (const failedOperation of ["compile", "free"] as const) {
			const failure = new Error(`EXPECTED_PRIVATE_${failedOperation}`);
			const { Compiler, state } = compilerFixture({
				[failedOperation](instance: { id: number }) {
					if (instance.id === 2) throw failure;
				},
			});
			const cached = create(Compiler, compilerOptions());
			const other = compilerOptions();
			other.connectionInfo.schemaName = "private";
			const independent = create(Compiler, other);
			expect(() =>
				failedOperation === "compile" ? independent.compile("bad") : independent.free(),
			).toThrow(failure);
			expect(() => cached.compile("no-stale-borrow")).toThrow("QUERY_COMPILER_REUSE_DISABLED");
			cached.free();
			independent.free();
			expect(state.instances.every((instance) => !instance.freed)).toBe(true);
			expect(state.freeAttempts).toBe(failedOperation === "free" ? 1 : 0);
		}
	});

	it("never revives a closed facade and closes an independent instance exactly once", () => {
		const { Compiler, state } = compilerFixture();
		const cached = create(Compiler, compilerOptions());
		const options = compilerOptions();
		options.connectionInfo.schemaName = "private";
		const privateFacade = create(Compiler, options);
		for (const facade of [cached, privateFacade]) {
			facade.free();
			facade.free();
			expect(() => facade.compile("closed")).toThrow("QUERY_COMPILER_FACADE_CLOSED");
			expect(() => facade.compileBatch("closed-batch")).toThrow("QUERY_COMPILER_FACADE_CLOSED");
		}
		expect(state.constructAttempts).toBe(2);
		expect(state.freeAttempts).toBe(1);
		expect(state.useAfterFree).toBe(0);
	});

	it("keeps at most one reusable options tuple per constructor without limiting independent clients", () => {
		const { Compiler, state } = compilerFixture();
		const first = create(Compiler, compilerOptions());
		for (let index = 0; index < 60; index++) {
			const options = compilerOptions();
			options.connectionInfo.schemaName = `independent_${index}`;
			const facade = create(Compiler, options);
			expect(facade.compile(`query-${index}`)).toMatchObject({ compilerId: index + 2 });
			facade.free();
		}
		const same = create(Compiler, compilerOptions());
		expect(state.constructAttempts).toBe(61);
		expect(state.freeAttempts).toBe(60);
		expect(same.compile("still-first")).toMatchObject({ compilerId: 1 });
		first.free();
		same.free();
	});

	it("isolates compiler constructors and does not poison another constructor's cache", () => {
		const failure = new Error("EXPECTED_CTOR_A_FAILURE");
		const a = compilerFixture({
			compile() {
				throw failure;
			},
		});
		const b = compilerFixture();
		const first = create(a.Compiler, compilerOptions());
		const other = create(b.Compiler, compilerOptions());
		expect(() => first.compile("bad")).toThrow(failure);
		const otherSecond = create(b.Compiler, compilerOptions());
		expect(b.state.constructAttempts).toBe(1);
		expect(otherSecond.compile("unaffected")).toMatchObject({ compilerId: 1 });
		first.free();
		other.free();
		otherSecond.free();
		expect(a.state.freeAttempts).toBe(0);
		expect(b.state.freeAttempts).toBe(0);
	});

	it.each(["P2009", "P2012", "P2013", "P2014", "P2019"])(
		"isolates recoverable %s validation errors without retrying the failed query",
		(code) => {
			const failure = {
				message: "EXPECTED_QUERY_VALIDATION",
				code,
				meta: { kind: code === "P2009" ? "UnknownSelectionField" : "RequiredArgumentMissing" },
			};
			const { Compiler, state } = compilerFixture({
				compile(_instance, query) {
					if (query === "invalid") throw failure;
				},
			});
			const first = create(Compiler, compilerOptions());
			const second = create(Compiler, compilerOptions());
			let caught: unknown;
			try {
				first.compile("invalid");
			} catch (error) {
				caught = error;
			}
			expect(caught).toBe(failure);
			expect(state.compileCalls).toBe(1);
			expect(state.constructAttempts).toBe(1);
			expect(second.compile("healthy-client")).toMatchObject({ compilerId: 2 });
			expect(first.compile("different-valid-query")).toMatchObject({ compilerId: 3 });
			expect(second.compileBatch("healthy-batch")).toMatchObject({ compilerId: 2 });
			first.free();
			second.free();
			expect(state.instances[0]?.freed).toBe(false);
			expect(state.freeAttempts).toBe(2);
		},
	);

	it("keeps a healthy client's later initialization error transformed after soft disable", () => {
		const failure = {
			message: "EXPECTED_VALIDATION",
			code: "P2009",
			meta: { kind: "UnknownSelectionField" },
		};
		const initFailure = new Error("EXPECTED_LATER_INIT_FAILURE");
		const transformed = new Error("PRESERVED_INITIALIZATION_ERROR");
		const { Compiler, state } = compilerFixture({
			construct(_options, attempt) {
				if (attempt === 2) throw initFailure;
			},
			compile(_instance, query) {
				if (query === "invalid") throw failure;
			},
		});
		const first = create(Compiler, compilerOptions());
		let transformedCount = 0;
		const second = create(Compiler, compilerOptions(), (error) => {
			expect(error).toBe(initFailure);
			transformedCount++;
			return transformed;
		});
		try {
			first.compile("invalid");
		} catch (error) {
			expect(error).toBe(failure);
		}
		expect(() => second.compile("valid-but-init-fails")).toThrow(transformed);
		expect(transformedCount).toBe(1);
		expect(state.constructAttempts).toBe(2);
		expect(state.compileCalls).toBe(1);
		first.free();
		second.free();
	});

	it("frees the temporary compiler when private initialization synchronously reenters the same facade", () => {
		const failure = {
			message: "EXPECTED_VALIDATION",
			code: "P2009",
			meta: { kind: "UnknownSelectionField" },
		};
		let facade!: CompilerFacade;
		let inner: unknown;
		const freed: number[] = [];
		const { Compiler, state } = compilerFixture({
			construct(_options, attempt) {
				if (attempt === 2) inner = facade.compile("inner-private-construction");
			},
			compile(_instance, query) {
				if (query === "invalid") throw failure;
			},
			free(instance) {
				freed.push(instance.id);
			},
		});
		facade = create(Compiler, compilerOptions());
		try {
			facade.compile("invalid");
		} catch (error) {
			expect(error).toBe(failure);
		}
		const outer = facade.compile("outer-private-construction");
		expect(inner).toMatchObject({ compilerId: 3, query: "inner-private-construction" });
		expect(outer).toMatchObject({ compilerId: 2, query: "outer-private-construction" });
		expect(state.constructAttempts).toBe(3);
		expect(state.compileCalls).toBe(3);
		facade.free();
		expect(freed.sort((a, b) => a - b)).toEqual([2, 3]);
		expect(state.instances.find((instance) => instance.id === 1)?.freed).toBe(false);
	});

	it("keeps unexpected-runtime and non-data validation-shaped failures hard disabled", () => {
		const shapes = [
			{ message: "unexpected", code: "P2009", meta: { kind: "UnexpectedRuntimeError" } },
			Object.assign(new Error("prototype-is-not-plain"), { code: "P2009", meta: {} }),
			Object.defineProperty({ message: "accessor", meta: {} }, "code", { get: () => "P2009" }),
		];
		for (const failure of shapes) {
			const { Compiler, state } = compilerFixture({
				compile() {
					throw failure;
				},
			});
			const first = create(Compiler, compilerOptions());
			const second = create(Compiler, compilerOptions());
			try {
				first.compile("invalid");
			} catch (error) {
				expect(error).toBe(failure);
			}
			expect(() => second.compile("next")).toThrow("QUERY_COMPILER_REUSE_DISABLED");
			expect(state.constructAttempts).toBe(1);
			first.free();
			second.free();
		}
	});

	it("upgrades a validation-shaped error to hard disable when the runtime panic hook fires", () => {
		const failure = {
			message: "validation-shaped-panic",
			code: "P2009",
			meta: { kind: "UnknownSelectionField" },
		};
		const { Compiler, state } = compilerFixture({
			compile() {
				throw failure;
			},
		});
		const first = create(Compiler, compilerOptions());
		const second = create(Compiler, compilerOptions());
		try {
			first.compile("panic");
		} catch (error) {
			expect(error).toBe(failure);
		}
		helper.hardDisableQueryCompilerReuse(Compiler);
		expect(() => second.compile("must-not-enter-poisoned-state")).toThrow(
			"QUERY_COMPILER_REUSE_DISABLED",
		);
		expect(state.constructAttempts).toBe(1);
		first.free();
		second.free();
		expect(state.freeAttempts).toBe(0);
	});

	it("keeps actual WASM glue ownership alive across facade free, garbage collection and quarantine", () => {
		const output = execFileSync(
			process.execPath,
			[
				"--expose-gc",
				path.resolve(
					import.meta.dirname,
					"../test-support/query-compiler-cache-wasm-ownership.mjs",
				),
				_entrypoint.toLowerCase(),
			],
			{ encoding: "utf8", windowsHide: true, timeout: 20_000 },
		);
		const result = JSON.parse(output.trim()) as {
			passed: boolean;
			entrypoint: string;
			realCompiler: boolean;
			gcControlCollected: boolean;
		};
		console.info("compiler-cache.real-wasm-ownership", JSON.stringify(result));
		expect(result).toMatchObject({
			passed: true,
			entrypoint: _entrypoint.toLowerCase(),
			realCompiler: true,
			gcControlCollected: true,
		});
	}, 25_000);
});
