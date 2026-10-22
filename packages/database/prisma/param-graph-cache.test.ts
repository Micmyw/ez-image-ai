import { createRequire } from "node:module";

import { PrismaPg } from "@prisma/adapter-pg";
import * as edgeEsm from "@prisma/client/runtime/wasm-compiler-edge";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const edgeCjs = createRequire(import.meta.url)(
	"@prisma/client/runtime/wasm-compiler-edge",
) as typeof edgeEsm;

function serializedGraph(encoded = "AAAA") {
	return {
		schema: {
			strings: [] as string[],
			graph: encoded,
		},
	};
}

let decodedBuffers: string[];
beforeEach(() => {
	decodedBuffers = [];
	vi.stubGlobal(
		"DataView",
		new Proxy(DataView, {
			construct(target, args, newTarget) {
				const result = Reflect.construct(target, args, newTarget) as DataView;
				decodedBuffers.push(
					Buffer.from(new Uint8Array(result.buffer, result.byteOffset, result.byteLength)).toString(
						"base64url",
					),
				);
				return result;
			},
		}),
	);
});
afterEach(() => vi.unstubAllGlobals());
function decodeCount(encoded = "AAAA") {
	return decodedBuffers.filter((value) => value === encoded).length;
}

function clientClass(
	runtime: typeof edgeEsm,
	schema: ReturnType<typeof serializedGraph>["schema"],
) {
	return runtime.getPrismaClient({
		clientVersion: "7.9.1",
		engineVersion: "param-graph-cache-regression",
		activeProvider: "postgresql",
		previewFeatures: [],
		inlineSchema: 'datasource db { provider = "postgresql" }',
		runtimeDataModel: { models: {}, enums: {}, types: {} },
		parameterizationSchema: schema,
	});
}

function adapter() {
	// Construction must not open a connection. A connection would fail immediately.
	return new PrismaPg({ connectionString: "postgresql://unused:unused@127.0.0.1:1/unused" });
}

describe.each([
	["ESM", edgeEsm],
	["CJS", edgeCjs],
] as const)("Prisma worker schema cache (%s)", (_entrypoint, runtime) => {
	it("decodes one immutable schema once across 50 independent clients", async () => {
		const graph = serializedGraph();
		const Client = clientClass(runtime, graph.schema);
		const clients = Array.from({ length: 50 }, () => new Client({ adapter: adapter() }));
		try {
			expect(new Set(clients).size).toBe(50);
			expect(new Set(clients.map((client) => client._engineConfig.adapter)).size).toBe(50);
			expect(decodeCount()).toBe(1);
		} finally {
			await Promise.all(clients.map((client) => client.$disconnect()));
		}
	});

	it("keeps distinct schema objects separate, including equal encodings", async () => {
		const first = serializedGraph();
		const second = serializedGraph();
		const First = clientClass(runtime, first.schema);
		const Second = clientClass(runtime, second.schema);
		const clients = [
			new First({ adapter: adapter() }),
			new Second({ adapter: adapter() }),
			new First({ adapter: adapter() }),
			new Second({ adapter: adapter() }),
		];
		try {
			expect(decodeCount()).toBe(2);
		} finally {
			await Promise.all(clients.map((client) => client.$disconnect()));
		}
	});

	it("does not reuse another schema or cache unsuccessful decoding", async () => {
		const valid = serializedGraph();
		const Valid = clientClass(runtime, valid.schema);
		const client = new Valid({ adapter: adapter() });
		const malformed = serializedGraph("AQ");
		const Invalid = clientClass(runtime, malformed.schema);
		try {
			expect(() => new Invalid({ adapter: adapter() })).toThrow();
			expect(() => new Invalid({ adapter: adapter() })).toThrow();
			expect(decodeCount("AQ")).toBe(2);
		} finally {
			await client.$disconnect();
		}
	});

	it("invalidates graph text, string-array replacement and in-place string changes", async () => {
		const graph = serializedGraph();
		const Client = clientClass(runtime, graph.schema);
		const clients = [new Client({ adapter: adapter() })];
		try {
			clients.push(new Client({ adapter: adapter() }));
			expect(decodeCount()).toBe(1);
			graph.schema.strings = ["first"];
			clients.push(new Client({ adapter: adapter() }));
			expect(decodeCount()).toBe(2);
			graph.schema.strings[0] = "second";
			clients.push(new Client({ adapter: adapter() }));
			expect(decodeCount()).toBe(3);
			graph.schema.strings.push("third");
			clients.push(new Client({ adapter: adapter() }));
			expect(decodeCount()).toBe(4);
			graph.schema.graph = "AQ";
			expect(() => new Client({ adapter: adapter() })).toThrow();
			expect(decodeCount("AQ")).toBe(1);
		} finally {
			await Promise.all(clients.map((client) => client.$disconnect()));
		}
	});
});
