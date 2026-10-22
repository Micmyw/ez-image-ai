import { createRequire } from "node:module";
import path from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";
import type * as edgeRuntime from "@prisma/client/runtime/wasm-compiler-edge";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../prisma/generated/client";
import { localSqlMetricsEnabled } from "../prisma/query-metrics";

type Config = Parameters<typeof edgeRuntime.getPrismaClient>[0];
type Mode =
	| "isolation"
	| "validation"
	| "unknown"
	| "panic"
	| "value"
	| "reentry"
	| "oversized"
	| "unsupported";
type EngineRequest = {
	modelName: string;
	action: string;
	query: { arguments: Record<string, unknown>; selection: Record<string, boolean> };
};
type Engine = {
	request(
		request: EngineRequest,
		options: { customDataProxyFetch?: (fetch: typeof globalThis.fetch) => typeof globalThis.fetch },
	): Promise<{ data: { findMany: Array<{ nested: { marker: string } }> } }>;
};

function engine(client: PrismaClient) {
	return (client as unknown as { _engine: Engine })._engine;
}

function request(ownerId: string): EngineRequest {
	return {
		modelName: "MediaAsset",
		action: "findMany",
		query: { arguments: { where: { ownerId } }, selection: { id: true } },
	};
}

/** Each permanent invalidation mode lives in its own Vitest file/process. The
 * installed loader caches by provider, not engineVersion. All normal plans are
 * compiled by the pinned real WASM; only the explicitly named value-plan tests
 * inject a plan, through the actual engine and interpreter. */
export function registerQueryPlanCachePostgresSuite(
	name: string,
	runtime: typeof edgeRuntime,
	mode: Mode = "isolation",
) {
	let connectionString: string;
	let config: Config;
	let cleanup: pg.Pool;
	let observedConstructor: unknown;
	const clients: PrismaClient[] = [];
	const owners: string[] = [];
	const compiler = {
		constructions: 0,
		compileCalls: 0,
		readCalls: 0,
		batchCalls: 0,
		freeCalls: 0,
		readShapes: [] as string[],
		rawErrorCodes: [] as unknown[],
	};
	let injection: { error: unknown; panic?: boolean } | { plan: unknown } | undefined;
	const require = createRequire(import.meta.url);
	const helper = require(
		path.join(
			path.dirname(require.resolve("@prisma/client/runtime/wasm-compiler-edge")),
			"query-compiler-reuse.js",
		),
	) as { hardDisableQueryCompilerReuse(constructor: unknown): void };

	beforeAll(async () => {
		const url = process.env.TEST_DATABASE_URL;
		if (!url || url === process.env.DATABASE_URL || !localSqlMetricsEnabled(url, "true"))
			throw new Error("ISOLATED_LOCAL_TEST_DATABASE_REQUIRED");
		const parsed = new URL(url);
		if (parsed.port !== "55432" || !/test/i.test(parsed.pathname))
			throw new Error("DEDICATED_LOOPBACK_TEST_DATABASE_REQUIRED");
		connectionString = url;
		cleanup = new pg.Pool({ connectionString, max: 1 });
		const template = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 1 }) });
		const source = (template as unknown as { _engineConfig: Config })._engineConfig;
		const wasm = source.compilerWasm;
		if (!wasm) throw new Error("PINNED_GENERATED_COMPILER_REQUIRED");
		config = {
			...source,
			compilerWasm: {
				...wasm,
				async getRuntime() {
					const loaded = await wasm.getRuntime();
					const Base = loaded.QueryCompiler;
					class ObservedCompiler extends Base {
						constructor(...args: ConstructorParameters<typeof Base>) {
							super(...args);
							compiler.constructions++;
						}
						compile(...args: Parameters<InstanceType<typeof Base>["compile"]>) {
							compiler.compileCalls++;
							if (JSON.parse(args[0]).action?.startsWith("find")) {
								compiler.readCalls++;
								compiler.readShapes.push(args[0]);
							}
							const injected = injection;
							injection = undefined;
							if (injected && "plan" in injected)
								return injected.plan as ReturnType<InstanceType<typeof Base>["compile"]>;
							if (injected) {
								if (injected.panic)
									(
										globalThis as unknown as {
											PRISMA_WASM_PANIC_REGISTRY: { set_message(message: string): void };
										}
									).PRISMA_WASM_PANIC_REGISTRY.set_message("EXPECTED_QUERY_PLAN_PANIC");
								throw injected.error;
							}
							try {
								return super.compile(...args);
							} catch (error) {
								compiler.rawErrorCodes.push((error as { code?: unknown })?.code);
								throw error;
							}
						}
						compileBatch(...args: Parameters<InstanceType<typeof Base>["compileBatch"]>) {
							compiler.batchCalls++;
							return super.compileBatch(...args);
						}
						free() {
							compiler.freeCalls++;
							return super.free();
						}
					}
					observedConstructor = ObservedCompiler;
					return { ...loaded, QueryCompiler: ObservedCompiler };
				},
			},
		};
		await template.$disconnect();
	});

	afterEach(async () => {
		injection = undefined;
		try {
			if (owners.length)
				await cleanup.query('DELETE FROM media_asset WHERE "ownerId" = ANY($1::text[])', [
					owners.splice(0),
				]);
		} finally {
			const results = await Promise.allSettled(
				clients.splice(0).map((client) => client.$disconnect()),
			);
			for (const result of results) expect(result.status).toBe("fulfilled");
		}
	});
	afterAll(async () => {
		await cleanup?.end();
	});

	function makeClient(disablePlans = false) {
		const sql = { count: 0 };
		const adapter = new PrismaPg({ connectionString, max: 1 });
		const connect = adapter.connect.bind(adapter);
		adapter.connect = async () => {
			const connection = await connect();
			const wrap = <T extends Pick<typeof connection, "queryRaw" | "executeRaw">>(queryable: T) => {
				const query = queryable.queryRaw.bind(queryable);
				const execute = queryable.executeRaw.bind(queryable);
				queryable.queryRaw = (input) => {
					sql.count++;
					return query(input);
				};
				queryable.executeRaw = (input) => {
					sql.count++;
					return execute(input);
				};
				return queryable;
			};
			const start = connection.startTransaction.bind(connection);
			connection.startTransaction = async (...args) => wrap(await start(...args));
			return wrap(connection);
		};
		const Client = runtime.getPrismaClient(config);
		const client = new Client({
			adapter,
			...(disablePlans ? { queryPlanCacheMaxSize: 0 } : {}),
		}) as unknown as PrismaClient;
		clients.push(client);
		return { client, sql };
	}
	function owner() {
		const value = `plan-cache-${name}-${mode}-${crypto.randomUUID()}`;
		owners.push(value);
		return value;
	}
	function create(
		client: PrismaClient,
		ownerId: string,
		width: number | null,
		kind: "INPUT" | "OUTPUT" = "INPUT",
	) {
		return client.mediaAsset.create({
			data: {
				ownerType: "USER",
				ownerId,
				kind,
				objectKey: `tests/${ownerId}/${crypto.randomUUID()}.png`,
				mimeType: "image/png",
				byteSize: BigInt(width ?? 1),
				width,
			},
		});
	}
	const read = (client: PrismaClient, ownerId: string) =>
		client.mediaAsset.findMany({ where: { ownerId }, select: { id: true } });

	describe(`actual installed ${name} shared single-read plans (${mode})`, () => {
		if (mode === "isolation") {
			it("reuses cross-client and private hits without sharing owner parameters, results or adapters", async () => {
				const first = makeClient();
				const second = makeClient();
				const ownerA = owner();
				const ownerB = owner();
				const a = await create(first.client, ownerA, 11);
				const b = await create(second.client, ownerB, 29);
				const query = (client: PrismaClient, ownerId: string, minimum: bigint) =>
					client.mediaAsset.findMany({
						where: { ownerId, byteSize: { gte: minimum } },
						select: { id: true, ownerId: true, width: true, byteSize: true },
					});
				const compiled = compiler.compileCalls;
				const left = await query(first.client, ownerA, 11n);
				expect(left).toEqual([{ id: a.id, ownerId: ownerA, width: 11, byteSize: 11n }]);
				left[0]!.ownerId = "mutated-return-value";
				await expect(query(second.client, ownerB, 29n)).resolves.toEqual([
					{ id: b.id, ownerId: ownerB, width: 29, byteSize: 29n },
				]);
				await expect(query(first.client, ownerA, 12n)).resolves.toEqual([]);
				await expect(query(first.client, ownerA, 1n)).resolves.toEqual([
					{ id: a.id, ownerId: ownerA, width: 11, byteSize: 11n },
				]);
				expect(compiler.compileCalls - compiled).toBe(1);
				expect(compiler.constructions).toBe(1);
				await first.client.$disconnect();
				await expect(query(second.client, ownerB, 1n)).resolves.toHaveLength(1);
				expect(compiler.freeCalls).toBe(0);
			});

			it("keeps enum, null and cursor arguments local to each execution", async () => {
				const first = makeClient();
				const second = makeClient();
				const ownerA = owner();
				const ownerB = owner();
				const a = await create(first.client, ownerA, null);
				const b = await create(second.client, ownerB, null);
				const a2 = await create(first.client, ownerA, 12, "OUTPUT");
				const b2 = await create(second.client, ownerB, 27, "OUTPUT");
				const nullable = (client: PrismaClient, ownerId: string) =>
					client.mediaAsset.findMany({
						where: { ownerId, width: null, kind: "INPUT" },
						select: { id: true, kind: true, width: true },
					});
				let compiled = compiler.compileCalls;
				await expect(nullable(first.client, ownerA)).resolves.toEqual([
					{ id: a.id, kind: "INPUT", width: null },
				]);
				await expect(nullable(second.client, ownerB)).resolves.toEqual([
					{ id: b.id, kind: "INPUT", width: null },
				]);
				expect(compiler.compileCalls - compiled).toBe(1);
				const enumQuery = (client: PrismaClient, ownerId: string, kind: "INPUT" | "OUTPUT") =>
					client.mediaAsset.findMany({
						where: { ownerId, kind },
						select: { id: true, kind: true, width: true },
					});
				compiled = compiler.compileCalls;
				await expect(enumQuery(first.client, ownerA, "INPUT")).resolves.toEqual([
					{ id: a.id, kind: "INPUT", width: null },
				]);
				await expect(enumQuery(second.client, ownerB, "OUTPUT")).resolves.toEqual([
					{ id: b2.id, kind: "OUTPUT", width: 27 },
				]);
				// The real ParamGraph retains enum literals in its key. Distinct
				// enum keys must compile independently; only identical keys may hit.
				expect(
					compiler.readShapes
						.slice(-2)
						.map((shape) => JSON.parse(shape).query.arguments.where.kind),
				).toEqual(["INPUT", "OUTPUT"]);
				expect(compiler.compileCalls - compiled).toBe(2);
				await expect(enumQuery(first.client, ownerA, "OUTPUT")).resolves.toEqual([
					{ id: a2.id, kind: "OUTPUT", width: 12 },
				]);
				await expect(enumQuery(second.client, ownerB, "INPUT")).resolves.toEqual([
					{ id: b.id, kind: "INPUT", width: null },
				]);
				expect(compiler.compileCalls - compiled).toBe(2);
				const cursor = (client: PrismaClient, ownerId: string, id: string) =>
					client.mediaAsset.findMany({
						where: { ownerId },
						cursor: { id },
						skip: 0,
						take: 1,
						orderBy: { id: "asc" },
						select: { id: true, width: true },
					});
				compiled = compiler.compileCalls;
				await expect(cursor(first.client, ownerA, a2.id)).resolves.toEqual([
					{ id: a2.id, width: 12 },
				]);
				await expect(cursor(second.client, ownerB, b2.id)).resolves.toEqual([
					{ id: b2.id, width: 27 },
				]);
				expect(compiler.compileCalls - compiled).toBe(1);
			});

			it("preserves findUniqueOrThrow, findFirstOrThrow and missing-row behavior", async () => {
				const first = makeClient();
				const second = makeClient();
				const ownerA = owner();
				const ownerB = owner();
				const a = await create(first.client, ownerA, 3);
				const b = await create(second.client, ownerB, 7);
				let compiled = compiler.compileCalls;
				await expect(
					first.client.mediaAsset.findUnique({
						where: { id: a.id },
						select: { ownerId: true, width: true },
					}),
				).resolves.toEqual({ ownerId: ownerA, width: 3 });
				await expect(
					second.client.mediaAsset.findUnique({
						where: { id: b.id },
						select: { ownerId: true, width: true },
					}),
				).resolves.toEqual({ ownerId: ownerB, width: 7 });
				await expect(
					second.client.mediaAsset.findUnique({
						where: { id: "plan-cache-missing" },
						select: { ownerId: true, width: true },
					}),
				).resolves.toBeNull();
				expect(compiler.compileCalls - compiled).toBe(1);
				compiled = compiler.compileCalls;
				await expect(
					first.client.mediaAsset.findUniqueOrThrow({
						where: { id: a.id },
						select: { ownerId: true },
					}),
				).resolves.toEqual({ ownerId: ownerA });
				await expect(
					second.client.mediaAsset.findUniqueOrThrow({
						where: { id: b.id },
						select: { ownerId: true },
					}),
				).resolves.toEqual({ ownerId: ownerB });
				await expect(
					first.client.mediaAsset.findUniqueOrThrow({
						where: { id: "plan-cache-missing" },
						select: { ownerId: true },
					}),
				).rejects.toMatchObject({ code: "P2025" });
				expect(compiler.compileCalls - compiled).toBe(1);
				compiled = compiler.compileCalls;
				await expect(
					first.client.mediaAsset.findFirstOrThrow({
						where: { ownerId: ownerA },
						select: { id: true },
					}),
				).resolves.toEqual({ id: a.id });
				await expect(
					second.client.mediaAsset.findFirstOrThrow({
						where: { ownerId: ownerB },
						select: { id: true },
					}),
				).resolves.toEqual({ id: b.id });
				await expect(
					second.client.mediaAsset.findFirstOrThrow({
						where: { ownerId: "plan-cache-missing" },
						select: { id: true },
					}),
				).rejects.toMatchObject({ code: "P2025" });
				expect(compiler.compileCalls - compiled).toBe(1);
			});

			it("honors queryPlanCacheMaxSize zero even after an enabled client warmed the shape", async () => {
				const first = makeClient();
				const disabled = makeClient(true);
				const ownerA = owner();
				const ownerB = owner();
				await create(first.client, ownerA, 1);
				await create(disabled.client, ownerB, 2);
				const query = (client: PrismaClient, ownerId: string) =>
					client.mediaAsset.findMany({
						where: { ownerId },
						select: { ownerId: true, checksum: true },
					});
				await query(first.client, ownerA);
				const compiled = compiler.compileCalls;
				for (let i = 0; i < 2; i++)
					await expect(query(disabled.client, ownerB)).resolves.toEqual([
						{ ownerId: ownerB, checksum: null },
					]);
				expect(compiler.compileCalls - compiled).toBe(2);
				await expect(query(first.client, ownerA)).resolves.toEqual([
					{ ownerId: ownerA, checksum: null },
				]);
				expect(compiler.compileCalls - compiled).toBe(2);
			});

			it("shares read compilation across independent transactions while rollback and sessions remain separate", async () => {
				const first = makeClient();
				const second = makeClient();
				const ownerA = owner();
				const ownerB = owner();
				const a = await create(first.client, ownerA, 4);
				const b = await create(second.client, ownerB, 9);
				const query = (client: Pick<PrismaClient, "mediaAsset">, ownerId: string) =>
					client.mediaAsset.findFirst({
						where: { ownerId },
						select: { width: true, ownerId: true },
					});
				await query(first.client, ownerA);
				const readsBefore = compiler.readCalls;
				const pids: number[] = [];
				let ready = 0;
				let release!: () => void;
				const barrier = new Promise<void>((resolve) => {
					release = resolve;
				});
				const pending = [first, second].map(({ client }, index) =>
					client
						.$transaction(
							async (tx) => {
								const ownerId = index === 0 ? ownerA : ownerB;
								const [row] = await tx.$queryRaw<
									Array<{ marker: string; pid: number }>
								>`SELECT set_config('ezpic.plan_probe', ${ownerId}, true) AS marker, pg_backend_pid() AS pid`;
								expect(row!.marker).toBe(ownerId);
								pids.push(row!.pid);
								if (++ready === 2) release();
								await barrier;
								await expect(query(tx, ownerId)).resolves.toEqual({
									width: index === 0 ? 4 : 9,
									ownerId,
								});
								await tx.mediaAsset.update({
									where: { id: index === 0 ? a.id : b.id },
									data: { width: index === 0 ? 104 : 209 },
								});
								await expect(
									tx.$queryRaw<
										Array<{ marker: string; pid: number }>
									>`SELECT current_setting('ezpic.plan_probe') AS marker, pg_backend_pid() AS pid`,
								).resolves.toEqual([{ marker: ownerId, pid: row!.pid }]);
								if (index === 0) throw new Error("EXPECTED_PLAN_CACHE_ROLLBACK");
							},
							{ timeout: 10_000 },
						)
						.catch((error: unknown) => {
							release();
							throw error;
						}),
				);
				const outcomes = await Promise.allSettled(pending);
				expect(outcomes[0]).toMatchObject({
					status: "rejected",
					reason: new Error("EXPECTED_PLAN_CACHE_ROLLBACK"),
				});
				expect(outcomes[1]?.status).toBe("fulfilled");
				expect(compiler.readCalls).toBe(readsBefore);
				expect(new Set(pids).size).toBe(2);
				await expect(query(first.client, ownerA)).resolves.toEqual({ width: 4, ownerId: ownerA });
				await expect(query(second.client, ownerB)).resolves.toEqual({
					width: 209,
					ownerId: ownerB,
				});
			});
			return;
		}

		it(`checks the warmed private plan boundary for ${mode}`, async () => {
			const first = makeClient();
			const second = makeClient();
			const ownerA = owner();
			const ownerB = owner();
			await first.client.$connect();
			const asset = await create(second.client, ownerB, 17);
			if (mode === "value") {
				injection = { plan: { type: "value", args: [{ nested: { marker: "original" } }] } };
				const compiled = compiler.compileCalls;
				const sql = second.sql.count;
				const left = await engine(second.client).request(request(ownerB), {});
				left.data.findMany[0]!.nested.marker = "mutated";
				const privateHit = await engine(second.client).request(request(ownerB), {});
				const sharedHit = await engine(first.client).request(request(ownerA), {});
				expect(privateHit.data.findMany).toEqual([{ nested: { marker: "original" } }]);
				expect(sharedHit.data.findMany).toEqual([{ nested: { marker: "original" } }]);
				expect(privateHit.data.findMany[0]).not.toBe(sharedHit.data.findMany[0]);
				expect(compiler.compileCalls - compiled).toBe(1);
				expect(second.sql.count).toBe(sql);
				return;
			}
			if (mode === "oversized" || mode === "unsupported") {
				injection = {
					plan: {
						type: "value",
						args: [{ nested: { marker: mode === "oversized" ? "x".repeat(70_000) : undefined } }],
					},
				};
				await engine(second.client).request(request(ownerB), {});
			} else {
				await expect(read(second.client, ownerB)).resolves.toEqual([{ id: asset.id }]);
			}
			const compiled = compiler.compileCalls;
			const constructions = compiler.constructions;
			const sqlBefore = first.sql.count + second.sql.count;
			if (mode === "reentry") {
				let hookCalls = 0;
				await expect(
					engine(second.client).request(request(ownerB), {
						customDataProxyFetch(fetch) {
							hookCalls++;
							helper.hardDisableQueryCompilerReuse(observedConstructor);
							return fetch;
						},
					}),
				).rejects.toThrow("QUERY_COMPILER_REUSE_DISABLED");
				expect(hookCalls).toBe(1);
				expect(compiler.compileCalls).toBe(compiled);
				expect(first.sql.count + second.sql.count).toBe(sqlBefore);
				return;
			}
			if (mode === "validation") {
				await expect(
					first.client.mediaAsset.findMany({
						where: { ownerId: ownerA },
						select: { id: true, deliberatelyUnknownCompilerField: true } as never,
					}),
				).rejects.toThrow(/deliberatelyUnknownCompilerField|Unknown field/);
				expect(compiler.rawErrorCodes).toContain("P2009");
			} else {
				injection =
					mode === "panic"
						? {
								panic: true,
								error: {
									message: "validation-shaped",
									code: "P2009",
									meta: { kind: "UnknownSelectionField" },
								},
							}
						: { error: new Error("EXPECTED_UNKNOWN_QUERY_PLAN_COMPILE") };
				const failure = first.client.mediaAsset.findMany({
					where: { ownerId: ownerA },
					select: { width: true },
				});
				if (mode === "panic")
					await expect(failure).rejects.toBeInstanceOf(runtime.PrismaClientRustPanicError);
				else await expect(failure).rejects.toThrow("EXPECTED_UNKNOWN_QUERY_PLAN_COMPILE");
			}
			expect(compiler.compileCalls - compiled).toBe(1);
			expect(first.sql.count + second.sql.count).toBe(sqlBefore);
			if (mode === "validation") {
				await expect(read(second.client, ownerB)).resolves.toEqual([{ id: asset.id }]);
				expect(compiler.compileCalls - compiled).toBe(2);
				expect(compiler.constructions - constructions).toBe(1);
				expect(first.sql.count + second.sql.count).toBeGreaterThan(sqlBefore);
			} else {
				await expect(engine(second.client).request(request(ownerB), {})).rejects.toThrow(
					"QUERY_COMPILER_REUSE_DISABLED",
				);
				expect(compiler.compileCalls - compiled).toBe(1);
				expect(compiler.constructions).toBe(constructions);
				expect(first.sql.count + second.sql.count).toBe(sqlBefore);
			}
		});
	});
}
