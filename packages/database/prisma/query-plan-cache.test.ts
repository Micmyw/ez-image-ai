import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const directory = path.dirname(require.resolve("@prisma/client/runtime/wasm-compiler-edge"));
interface Facade {
	compile(request: string): unknown;
	compileBatch(request: string): unknown;
	free(): void;
}
interface Helper {
	captureQueryPlanNamespace(schema: unknown, enums: unknown): unknown;
	createReusableQueryCompiler(
		constructor: new (...args: never[]) => Facade,
		options: unknown,
		transform?: (error: unknown) => unknown,
		namespace?: unknown,
	): Facade;
	hardDisableQueryCompilerReuse(constructor: new (...args: never[]) => Facade): void;
	isQueryPlanReusable(compiler: Facade, plan: unknown): boolean;
	prepareQueryPlanForExecution(
		compiler: Facade,
		request: { plan: unknown; [key: string]: unknown },
	): { plan: unknown; [key: string]: unknown };
}
const cjs = require(path.join(directory, "query-compiler-reuse.js")) as Helper;
const esm = (await import(
	pathToFileURL(path.join(directory, "query-compiler-reuse.mjs")).href
)) as Helper;
const options = {
	datamodel: "model PlanProbe { id Int @id }",
	provider: "postgres",
	connectionInfo: { schemaName: "public", supportsRelationJoins: true },
};
const key = (action = "findMany", owner = "owner-a", selection: unknown = { id: true }) =>
	JSON.stringify({
		modelName: "PlanProbe",
		action,
		query: { arguments: { where: { owner } }, selection },
	});
const metadata = () => ({ graph: "exact-native-graph", strings: ["owner", "id"] });

function fixture() {
	const state = {
		constructed: 0,
		single: 0,
		batch: 0,
		freed: 0,
		failure: undefined as unknown,
		hook: undefined as (() => void) | undefined,
		result: undefined as unknown,
	};
	class Compiler {
		constructor() {
			state.constructed++;
		}
		compile(request: string) {
			state.single++;
			state.hook?.();
			if (state.failure !== undefined) {
				const error = state.failure;
				state.failure = undefined;
				throw error;
			}
			return (
				state.result ?? {
					type: "value",
					args: { request, nested: { list: [{ value: 1 }], nullable: null } },
				}
			);
		}
		compileBatch(request: string) {
			state.batch++;
			return { type: "value", args: request };
		}
		free() {
			state.freed++;
		}
	}
	return { Compiler, state };
}

it("shares the same plan provenance and epoch owner across CJS and ESM", () => {
	for (const name of [
		"captureQueryPlanNamespace",
		"isQueryPlanReusable",
		"prepareQueryPlanForExecution",
	] as const)
		expect(esm[name]).toBe(cjs[name]);
});

describe.each([
	["CJS", cjs],
	["ESM", esm],
] as const)("bounded single-read templates (%s)", (_name, helper) => {
	function setup() {
		const { Compiler, state } = fixture();
		const namespace = helper.captureQueryPlanNamespace(metadata(), {});
		const create = (ns = namespace, opts = options) =>
			helper.createReusableQueryCompiler(Compiler, opts, undefined, ns);
		return { Compiler, state, namespace, create, first: create(), second: create() };
	}
	it.each(["findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany"])(
		"shares only successful %s templates and copies every execution",
		(action) => {
			const { state, first, second } = setup();
			const query = key(action),
				left = first.compile(query),
				right = second.compile(query);
			expect(state.single).toBe(1);
			expect(left).toEqual(right);
			expect(left).not.toBe(right);
			expect(Object.isFrozen(left)).toBe(true);
			const firstRun = helper.prepareQueryPlanForExecution(first, {
				plan: left,
				placeholderValues: { owner: "a" },
			});
			const secondRun = helper.prepareQueryPlanForExecution(first, {
				plan: left,
				placeholderValues: { owner: "b" },
			});
			const a = firstRun.plan as { args: { nested: { list: Array<{ value: number }> } } };
			const b = secondRun.plan as typeof a;
			a.args.nested.list[0]!.value = 99;
			expect(b.args.nested.list[0]!.value).toBe(1);
			expect(left).toEqual(right);
			expect(firstRun.placeholderValues).toEqual({ owner: "a" });
			expect(secondRun.placeholderValues).toEqual({ owner: "b" });
			expect(state.single).toBe(1);
		},
	);
	it.each([
		"aggregate",
		"groupBy",
		"count",
		"createOne",
		"updateOne",
		"deleteOne",
		"createMany",
		"queryRaw",
		"executeRaw",
	])("leaves %s on its original protocol", (action) => {
		const { state, first, second } = setup();
		const plan = first.compile(key(action));
		second.compile(key(action));
		expect(state.single).toBe(2);
		const request = { plan };
		expect(helper.prepareQueryPlanForExecution(first, request)).toBe(request);
	});
	it("does not cache batch compilation", () => {
		const { first, second, state } = setup();
		first.compileBatch(key());
		second.compileBatch(key());
		expect(state.batch).toBe(2);
	});
	it("uses the complete native key, retaining parameter equality and unknown literal distinctions", () => {
		const { first, second, state } = setup();
		for (const query of [
			key("findMany", "alice"),
			key("findMany", "bob"),
			key("findMany", "alice", { id: true, owner: true }),
			key("findFirst", "alice"),
		]) {
			expect(first.compile(query)).toEqual(second.compile(query));
		}
		expect(state.single).toBe(4);
	});
	it("isolates graph, dictionary, enum and compiler metadata without hash aliases", () => {
		const { first, create, state } = setup();
		first.compile(key());
		const namespaces = [
			helper.captureQueryPlanNamespace({ ...metadata(), graph: "other-graph" }, {}),
			helper.captureQueryPlanNamespace({ ...metadata(), strings: ["id", "owner"] }, {}),
			helper.captureQueryPlanNamespace(metadata(), {
				Kind: { values: [{ name: "A", dbName: "db_a" }] },
			}),
		];
		for (const namespace of namespaces) create(namespace).compile(key());
		create(helper.captureQueryPlanNamespace(metadata(), {})).compile(key());
		expect(state.single).toBe(4);
		create(undefined, { ...options, datamodel: options.datamodel + " // new" }).compile(key());
		expect(state.constructed).toBe(2);
		expect(state.single).toBe(5);
	});
	it("snapshots mutable namespace sources and rejects unfamiliar metadata", () => {
		const source = metadata(),
			enums = { Kind: { values: [{ name: "A", dbName: "a" }] } };
		const original = helper.captureQueryPlanNamespace(source, enums);
		expect(helper.captureQueryPlanNamespace(source, enums)).toBe(original);
		source.strings[0] = "mutated";
		expect(helper.captureQueryPlanNamespace(source, enums)).not.toBe(original);
		enums.Kind.values[0]!.dbName = "b";
		expect(helper.captureQueryPlanNamespace(source, enums)).not.toBe(original);
		let reads = 0;
		expect(
			helper.captureQueryPlanNamespace(
				Object.defineProperty(metadata(), "graph", {
					get() {
						reads++;
						return "x";
					},
				}),
				{},
			),
		).toBeUndefined();
		expect(helper.captureQueryPlanNamespace({ ...metadata(), future: true }, {})).toBeUndefined();
		expect(reads).toBe(0);
	});
	it("reuses a validated immutable metadata snapshot without rescanning its dictionary", () => {
		let inspected = 0;
		const source = Object.freeze({
			graph: "immutable-graph",
			strings: Object.freeze(["owner", "id"]),
		});
		const schema = new Proxy(source, {
			ownKeys(target) {
				inspected++;
				return Reflect.ownKeys(target);
			},
		});
		const namespace = helper.captureQueryPlanNamespace(schema, {});
		expect(namespace).toBeDefined();
		expect(Object.isFrozen(namespace)).toBe(true);
		inspected = 0;
		expect(helper.captureQueryPlanNamespace(schema, {})).toBe(namespace);
		expect(inspected).toBe(0);
		const changedEnum = helper.captureQueryPlanNamespace(schema, {
			Kind: { values: [{ name: "A", dbName: "a" }] },
		});
		expect(changedEnum).not.toBe(namespace);
		expect(inspected).toBe(0);
	});
	it.each([
		["undefined", () => ({ value: undefined })],
		["BigInt", () => ({ value: 1n })],
		["Date", () => ({ value: new Date() })],
		["NaN", () => ({ value: Number.NaN })],
		["negative-zero", () => ({ value: -0 })],
		["function", () => ({ value() {} })],
		["sparse", () => ({ value: Array(2) })],
		["symbol", () => ({ [Symbol("x")]: 1 })],
		[
			"cycle",
			() => {
				const value: { self?: unknown } = {};
				value.self = value;
				return value;
			},
		],
		[
			"shared-reference",
			() => {
				const value = {};
				return { a: value, b: value };
			},
		],
	] as const)(
		"bypasses unsupported %s plans without changing their returned value",
		(_label, produce) => {
			const { first, second, state } = setup();
			state.result = produce();
			const plan = first.compile(key());
			second.compile(key());
			expect(plan).toBe(state.result);
			expect(state.single).toBe(2);
			const request = { plan };
			expect(helper.prepareQueryPlanForExecution(first, request)).toBe(request);
		},
	);
	it("never invokes plan accessors or toJSON during cache inspection", () => {
		const { first, state } = setup();
		let reads = 0;
		state.result = {
			get value() {
				reads++;
				return 1;
			},
			toJSON() {
				reads++;
				return {};
			},
		};
		expect(first.compile(key())).toBe(state.result);
		expect(reads).toBe(0);
	});
	it("bounds entries and allows evicted private templates to execute with fresh copies", () => {
		const { first, second, state } = setup();
		const firstPlan = first.compile(key("findMany", "0"));
		for (let index = 1; index <= 256; index++) first.compile(key("findMany", String(index)));
		const before = state.single;
		const left = helper.prepareQueryPlanForExecution(first, { plan: firstPlan }).plan;
		const right = helper.prepareQueryPlanForExecution(first, { plan: firstPlan }).plan;
		expect(left).toEqual(right);
		expect(left).not.toBe(right);
		expect(state.single).toBe(before);
		second.compile(key("findMany", "0"));
		expect(state.single).toBe(before + 1);
	});
	it("bounds serialized key/template bytes and bypasses an oversized template", () => {
		const { first, second, state } = setup();
		state.result = { type: "value", args: "x".repeat(22000) };
		first.compile(key("findMany", "0"));
		for (let index = 1; index < 60; index++) first.compile(key("findMany", String(index)));
		const before = state.single;
		second.compile(key("findMany", "0"));
		expect(state.single).toBe(before + 1);
		state.result = { type: "value", args: "x".repeat(70000) };
		const query = key("findMany", "oversized"),
			plan = first.compile(query);
		expect(plan).toBe(state.result);
		second.compile(query);
		expect(state.single).toBe(before + 3);
	});
	it("invalidates warm private plans on soft failure and never retries the failed call", () => {
		const { first, second, state } = setup();
		const plan = second.compile(key());
		const failure = {
			code: "P2009",
			message: "invalid selection",
			meta: { kind: "UnknownSelectionField" },
		};
		state.failure = failure;
		try {
			first.compile(key("findMany", "invalid"));
			expect.fail("must throw");
		} catch (error) {
			expect(error).toBe(failure);
		}
		expect(state.single).toBe(2);
		expect(state.constructed).toBe(1);
		expect(helper.isQueryPlanReusable(second, plan)).toBe(false);
		expect(() => helper.prepareQueryPlanForExecution(second, { plan })).toThrow(
			"QUERY_COMPILER_REUSE_DISABLED",
		);
		const next = second.compile(key());
		expect(state.constructed).toBe(2);
		expect(state.single).toBe(3);
		const request = { plan: next };
		expect(helper.prepareQueryPlanForExecution(second, request)).toBe(request);
	});
	it.each(["unknown", "panic"] as const)(
		"rejects old private plans after %s invalidation while future independent owners retain their lifecycle",
		(kind) => {
			const { first, second, state, Compiler, create } = setup();
			const plan = second.compile(key());
			if (kind === "panic") helper.hardDisableQueryCompilerReuse(Compiler);
			else {
				state.failure = new Error("UNKNOWN_FAILURE");
				expect(() => first.compile(key("findMany", "fail"))).toThrow("UNKNOWN_FAILURE");
			}
			expect(helper.isQueryPlanReusable(second, plan)).toBe(false);
			expect(() => helper.prepareQueryPlanForExecution(second, { plan })).toThrow(
				"QUERY_COMPILER_REUSE_DISABLED",
			);
			expect(() => second.compile(key())).toThrow("QUERY_COMPILER_REUSE_DISABLED");
			const fresh = create();
			fresh.compile(key());
			fresh.free();
			expect(state.freed).toBe(1);
		},
	);
	it.each(["oversized", "unsupported", "namespace-mismatch"] as const)(
		"invalidates an unshared warm %s private-cache entry",
		(kind) => {
			const { first, state, Compiler, create } = setup();
			if (kind === "oversized") state.result = { type: "value", args: "x".repeat(70000) };
			if (kind === "unsupported") state.result = { type: "value", args: new Date() };
			const compiler =
				kind === "namespace-mismatch"
					? create(helper.captureQueryPlanNamespace({ ...metadata(), graph: "other" }, {}))
					: first;
			const plan = compiler.compile(key());
			expect(helper.isQueryPlanReusable(compiler, plan)).toBe(true);
			helper.hardDisableQueryCompilerReuse(Compiler);
			expect(helper.isQueryPlanReusable(compiler, plan)).toBe(false);
			expect(() => compiler.compile(key())).toThrow("QUERY_COMPILER_REUSE_DISABLED");
		},
	);
	it("rejects closed and cross-facade provenance without closing another client", () => {
		const { first, second } = setup();
		const a = first.compile(key()),
			b = second.compile(key());
		expect(helper.isQueryPlanReusable(second, a)).toBe(false);
		expect(() => helper.prepareQueryPlanForExecution(second, { plan: a })).toThrow(
			"QUERY_COMPILER_REUSE_DISABLED",
		);
		first.free();
		expect(helper.isQueryPlanReusable(first, a)).toBe(false);
		expect(helper.isQueryPlanReusable(second, b)).toBe(true);
	});
	it("keeps busy/reentrant compilation independent and does not publish a template after epoch change", () => {
		const { first, second, state, Compiler } = setup();
		let nested: unknown;
		state.hook = () => {
			state.hook = undefined;
			nested = second.compile(key());
		};
		first.compile(key("findMany", "outer"));
		expect(state.constructed).toBe(2);
		const request = { plan: nested };
		expect(helper.prepareQueryPlanForExecution(second, request)).toBe(request);
		second.compile(key());
		expect(state.single).toBe(3);
		state.hook = () => {
			state.hook = undefined;
			helper.hardDisableQueryCompilerReuse(Compiler);
		};
		expect(() => first.compile(key("findMany", "panic-during-compile"))).toThrow(
			"QUERY_COMPILER_REUSE_DISABLED",
		);
	});
});
