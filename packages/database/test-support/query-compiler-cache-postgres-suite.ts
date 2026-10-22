import { PrismaPg } from "@prisma/adapter-pg";
import type * as edgeRuntime from "@prisma/client/runtime/wasm-compiler-edge";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../prisma/generated/client";
import { localSqlMetricsEnabled } from "../prisma/query-metrics";

type EdgeConfig = Parameters<typeof edgeRuntime.getPrismaClient>[0];

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((done, failed) => {
		resolve = done;
		reject = failed;
	});
	return { promise, resolve, reject };
}

/** Real installed edge engines, real compiler glue/WASM and isolated local PostgreSQL. */
export function registerQueryCompilerCachePostgresSuite(
	name: string,
	runtime: typeof edgeRuntime,
	mode: "isolation" | "engine-errors" | "initialization" = "isolation",
) {
	let connectionString: string;
	let config: EdgeConfig;
	let reference: PrismaClient;
	const clients: PrismaClient[] = [];
	const owners: string[] = [];
	const compiler = { constructions: 0, compileCalls: 0, batchCalls: 0, freeCalls: 0 };
	let latestCompilerDatamodel: unknown;
	let latestCompilerConnectionInfo: unknown;
	let injected: { error: unknown; signalPanic?: boolean } | undefined;
	function injectError() {
		if (!injected) return;
		const current = injected;
		injected = undefined;
		if (current.signalPanic) {
			(
				globalThis as unknown as {
					PRISMA_WASM_PANIC_REGISTRY: { set_message(message: string): void };
				}
			).PRISMA_WASM_PANIC_REGISTRY.set_message("EXPECTED_TEST_PANIC_HOOK_SIGNAL");
		}
		throw current.error;
	}

	beforeAll(async () => {
		const url = process.env.TEST_DATABASE_URL;
		if (!url || url === process.env.DATABASE_URL || !localSqlMetricsEnabled(url, "true"))
			throw new Error("ISOLATED_LOCAL_TEST_DATABASE_REQUIRED");
		const parsed = new URL(url);
		if (parsed.port !== "55432" || !/test/i.test(parsed.pathname))
			throw new Error("DEDICATED_LOOPBACK_TEST_DATABASE_REQUIRED");
		connectionString = url;
		const template = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
		const original = (template as unknown as { _engineConfig: EdgeConfig })._engineConfig;
		const wasm = original.compilerWasm;
		if (!wasm) throw new Error("GENERATED_QUERY_COMPILER_REQUIRED");
		config = {
			...original,
			engineVersion: "query-compiler-cache-regression",
			compilerWasm: {
				...wasm,
				async getRuntime() {
					const loaded = await wasm.getRuntime();
					const Base = loaded.QueryCompiler;
					class ObservedCompiler extends Base {
						constructor(...args: ConstructorParameters<typeof Base>) {
							latestCompilerDatamodel = args[0].datamodel;
							latestCompilerConnectionInfo = args[0].connectionInfo;
							super(...args);
							compiler.constructions++;
						}
						compile(...args: Parameters<InstanceType<typeof Base>["compile"]>) {
							compiler.compileCalls++;
							injectError();
							return super.compile(...args);
						}
						compileBatch(...args: Parameters<InstanceType<typeof Base>["compileBatch"]>) {
							compiler.batchCalls++;
							injectError();
							return super.compileBatch(...args);
						}
						free() {
							compiler.freeCalls++;
							return super.free();
						}
					}
					return { ...loaded, QueryCompiler: ObservedCompiler };
				},
			},
		};
		await template.$disconnect();
		reference = makeClient(false);
		await reference.$connect();
		expect(compiler.constructions).toBe(1);
	});

	afterEach(async () => {
		try {
			const cleanupOwners = owners.splice(0);
			if (cleanupOwners.length) {
				const cleanupClient = mode === "initialization" ? makeClient() : reference;
				await cleanupClient.mediaAsset.deleteMany({ where: { ownerId: { in: cleanupOwners } } });
			}
		} finally {
			await Promise.all(clients.splice(0).map((client) => client.$disconnect()));
		}
	});
	afterAll(() => reference?.$disconnect());

	function makeClient(track = true) {
		const Client = runtime.getPrismaClient(config);
		const client = new Client({
			adapter: new PrismaPg({ connectionString, max: 1 }),
		}) as unknown as PrismaClient;
		if (track) clients.push(client);
		return client;
	}

	function fixtureOwner() {
		const owner = `compiler-cache-${name}-${crypto.randomUUID()}`;
		owners.push(owner);
		return owner;
	}

	function createAsset(client: PrismaClient, ownerId: string, width: number) {
		return client.mediaAsset.create({
			data: {
				ownerType: "USER",
				ownerId,
				kind: "INPUT",
				objectKey: `tests/${ownerId}/${crypto.randomUUID()}.png`,
				mimeType: "image/png",
				byteSize: BigInt(width),
				width,
			},
		});
	}

	if (mode === "initialization") {
		describe(`actual edge compiler initialization (${name})`, () => {
			it("rejects invalid compiler metadata before any raw write reaches PostgreSQL", async () => {
				const asset = await createAsset(reference, fixtureOwner(), 31);
				// The pinned WASM constructor parses schema text without validation.
				// A non-string connection schema is a real constructor deserialization
				// failure, even when the next query would otherwise use raw SQL.
				const adapter = new PrismaPg({ connectionString, max: 1 }, { schema: 123 as never });
				let rawExecutions = 0;
				const connect = adapter.connect.bind(adapter);
				adapter.connect = async () => {
					const connection = await connect();
					const execute = connection.executeRaw.bind(connection);
					connection.executeRaw = (query) => {
						rawExecutions++;
						return execute(query);
					};
					return connection;
				};
				const InvalidClient = runtime.getPrismaClient(config);
				const invalid = new InvalidClient({
					adapter,
				}) as unknown as PrismaClient;
				clients.push(invalid);
				await expect(invalid.$executeRaw`
					UPDATE media_asset SET width = 999 WHERE id = ${asset.id}
				`).rejects.toThrow(/invalid type:.*expected a string/);
				expect(latestCompilerDatamodel).toBe(config.inlineSchema);
				expect(latestCompilerConnectionInfo).toMatchObject({ schemaName: 123 });
				expect(rawExecutions).toBe(0);
				const healthy = makeClient();
				await expect(
					healthy.mediaAsset.findUnique({ where: { id: asset.id }, select: { width: true } }),
				).resolves.toEqual({ width: 31 });
			});
		});
		return;
	}

	if (mode === "engine-errors") {
		describe(`actual edge engine error boundaries (${name})`, () => {
			it("routes the real engine panic hook to hard disable even for a validation-shaped throw", async () => {
				const first = makeClient();
				const second = makeClient();
				await Promise.all([first.$connect(), second.$connect()]);
				const before = compiler.compileCalls;
				const constructionsBefore = compiler.constructions;
				injected = {
					signalPanic: true,
					error: {
						message: "validation-shaped",
						code: "P2009",
						meta: { kind: "UnknownSelectionField" },
					},
				};
				await expect(
					first.mediaAsset.findMany({
						where: { ownerId: "compiler-hook-no-write" },
						select: { id: true },
					}),
				).rejects.toBeInstanceOf(runtime.PrismaClientRustPanicError);
				expect(compiler.compileCalls - before).toBe(1);
				await expect(
					second.mediaAsset.findMany({
						where: { ownerId: "compiler-hook-no-write" },
						select: { width: true },
					}),
				).rejects.toThrow("QUERY_COMPILER_REUSE_DISABLED");
				expect(compiler.constructions).toBe(constructionsBefore);
			});

			it.each(["single", "batch"] as const)(
				"preserves InitializationError through the actual %s compile transforms",
				async (kind) => {
					const client = makeClient();
					await client.$connect();
					const initialization = new runtime.PrismaClientInitializationError(
						"EXPECTED_TRANSFORM_INITIALIZATION_FAILURE",
						"7.9.1",
						"P5010",
					);
					expect(initialization.errorCode).toBe("P5010");
					injected = { error: initialization };
					let caught: unknown;
					try {
						if (kind === "single")
							await client.mediaAsset.findMany({ select: { id: true }, take: 1 });
						else
							await client.$transaction([
								client.mediaAsset.findMany({ select: { id: true }, take: 1 }),
								client.mediaAsset.count(),
							]);
					} catch (error) {
						caught = error;
					}
					expect(caught).toBeInstanceOf(runtime.PrismaClientInitializationError);
					expect(caught).not.toBeInstanceOf(runtime.PrismaClientUnknownRequestError);
					// The unchanged public RequestHandler rebuilds initialization errors
					// without errorCode; the compile transform must preserve their class.
					expect(caught).toMatchObject({
						message: expect.stringContaining("EXPECTED_TRANSFORM_INITIALIZATION_FAILURE"),
					});
				},
			);
		});
		return;
	}

	describe(`actual edge compiler borrowing with PostgreSQL (${name})`, () => {
		it("shares only compiler work while keeping two clients, adapters, parameters and plans separate", async () => {
			const first = makeClient();
			const second = makeClient();
			expect(first).not.toBe(second);
			expect(
				(first as unknown as { _engineConfig: { adapter: unknown } })._engineConfig.adapter,
			).not.toBe(
				(second as unknown as { _engineConfig: { adapter: unknown } })._engineConfig.adapter,
			);
			const ownerA = fixtureOwner();
			const ownerB = fixtureOwner();
			const [a, b] = await Promise.all([
				createAsset(first, ownerA, 11),
				createAsset(second, ownerB, 29),
			]);
			for (let round = 0; round < 3; round++) {
				const [left, right] = await Promise.all([
					first.$transaction([
						first.mediaAsset.findMany({
							where: { ownerId: ownerA, byteSize: { gte: 11n } },
							select: { id: true, ownerId: true },
						}),
						first.$queryRaw<Array<{ marker: string }>>`SELECT ${`left-${round}`}::text AS marker`,
					]),
					second.$transaction([
						second.$queryRaw<Array<{ marker: string }>>`SELECT ${`right-${round}`}::text AS marker`,
						second.mediaAsset.findUnique({
							where: { id: b.id },
							select: { width: true, byteSize: true },
						}),
					]),
				]);
				expect(left).toEqual([[{ id: a.id, ownerId: ownerA }], [{ marker: `left-${round}` }]]);
				expect(right).toEqual([[{ marker: `right-${round}` }], { width: 29, byteSize: 29n }]);
			}
			expect(compiler.compileCalls).toBeGreaterThan(0);
			expect(compiler.batchCalls).toBeGreaterThan(0);
			expect(compiler.constructions).toBe(1);
			await first.$disconnect();
			await expect(
				second.mediaAsset.findUnique({ where: { id: b.id }, select: { ownerId: true } }),
			).resolves.toEqual({ ownerId: ownerB });
			expect(compiler.freeCalls).toBe(0);
		});

		it("evaluates cuid, now and updatedAt for each execution instead of freezing them in the compiler", async () => {
			const first = makeClient();
			const second = makeClient();
			const ownerA = fixtureOwner();
			const ownerB = fixtureOwner();
			const a = await createAsset(first, ownerA, 3);
			await new Promise((resolve) => setTimeout(resolve, 15));
			const b = await createAsset(second, ownerB, 7);
			expect(a.id).not.toBe(b.id);
			expect(a.id).toMatch(/^c[a-z0-9]+$/);
			expect(b.id).toMatch(/^c[a-z0-9]+$/);
			expect(b.createdAt.getTime()).toBeGreaterThan(a.createdAt.getTime());
			expect(b.ownerId).toBe(ownerB);
			await new Promise((resolve) => setTimeout(resolve, 15));
			const changed = await first.mediaAsset.update({ where: { id: a.id }, data: { width: 13 } });
			expect(changed.createdAt).toEqual(a.createdAt);
			expect(changed.updatedAt.getTime()).toBeGreaterThan(a.updatedAt.getTime());
			expect(compiler.constructions).toBe(1);
		});

		it("holds distinct PostgreSQL transactions and keeps the second alive after the first disconnects", async () => {
			const pair = [makeClient(), makeClient()];
			const ready = [deferred<number>(), deferred<number>()];
			const release = [deferred(), deferred()];
			const pending = pair.map((client, index) => {
				const marker = `compiler-${index}-${crypto.randomUUID()}`;
				const transaction = client.$transaction(
					async (tx) => {
						const [row] = await tx.$queryRaw<Array<{ marker: string; pid: number }>>`
						SELECT set_config('ezpic.compiler_probe', ${marker}, true) AS marker, pg_backend_pid() AS pid
					`;
						expect(row?.marker).toBe(marker);
						ready[index]!.resolve(row!.pid);
						await release[index]!.promise;
						await expect(tx.$queryRaw<Array<{ marker: string; pid: number }>>`
						SELECT current_setting('ezpic.compiler_probe') AS marker, pg_backend_pid() AS pid
					`).resolves.toEqual([{ marker, pid: row!.pid }]);
					},
					{ timeout: 10_000 },
				);
				void transaction.catch(ready[index]!.reject);
				return transaction;
			});
			try {
				expect(new Set(await Promise.all(ready.map((gate) => gate.promise))).size).toBe(2);
				release[0]!.resolve();
				await pending[0];
				await pair[0]!.$disconnect();
				release[1]!.resolve();
				await pending[1];
				await expect(pair[1]!.$queryRaw`SELECT 42 AS value`).resolves.toEqual([{ value: 42 }]);
				expect(compiler.constructions).toBe(1);
			} finally {
				for (const gate of release) gate.resolve();
				await Promise.allSettled(pending);
			}
		});

		it("rolls back one owner's write without undoing another client's committed write", async () => {
			const first = makeClient();
			const second = makeClient();
			const [a, b] = await Promise.all([
				createAsset(first, fixtureOwner(), 5),
				createAsset(second, fixtureOwner(), 8),
			]);
			const result = await Promise.allSettled([
				first.$transaction(async (tx) => {
					await tx.mediaAsset.update({ where: { id: a.id }, data: { width: 105 } });
					throw new Error("EXPECTED_COMPILER_CACHE_ROLLBACK");
				}),
				second.$transaction((tx) =>
					tx.mediaAsset.update({ where: { id: b.id }, data: { width: 208 } }),
				),
			]);
			expect(result[0]).toMatchObject({
				status: "rejected",
				reason: new Error("EXPECTED_COMPILER_CACHE_ROLLBACK"),
			});
			expect(result[1]?.status).toBe("fulfilled");
			await expect(
				reference.mediaAsset.findUnique({ where: { id: a.id }, select: { width: true } }),
			).resolves.toEqual({ width: 5 });
			await expect(
				reference.mediaAsset.findUnique({ where: { id: b.id }, select: { width: true } }),
			).resolves.toEqual({ width: 208 });
			expect(compiler.constructions).toBe(1);
		});

		it("does not let a real compiler validation error break an already existing healthy client", async () => {
			const broken = makeClient();
			const healthy = makeClient();
			const owner = fixtureOwner();
			const asset = await createAsset(healthy, owner, 21);
			await broken.$connect();
			const before = compiler.compileCalls;
			await expect(
				broken.mediaAsset.findMany({
					where: { ownerId: owner },
					select: { id: true, deliberatelyUnknownCompilerField: true } as never,
				}),
			).rejects.toThrow(/deliberatelyUnknownCompilerField|Unknown field/);
			expect(compiler.compileCalls - before).toBe(1);
			await expect(
				healthy.$transaction((tx) =>
					tx.mediaAsset.update({
						where: { id: asset.id },
						data: { width: 121 },
						select: { ownerId: true, width: true },
					}),
				),
			).resolves.toEqual({ ownerId: owner, width: 121 });
			await expect(
				reference.mediaAsset.findUnique({ where: { id: asset.id }, select: { width: true } }),
			).resolves.toEqual({ width: 121 });
		});
	});
}
