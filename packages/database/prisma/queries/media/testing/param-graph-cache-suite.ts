import { PrismaPg } from "@prisma/adapter-pg";
import type * as edgeEsm from "@prisma/client/runtime/wasm-compiler-edge";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../../../generated/client";
import { localSqlMetricsEnabled } from "../../../query-metrics";

type EdgeConfig = Parameters<typeof edgeEsm.getPrismaClient>[0];
export function registerParamGraphCacheSuite(entrypoint: string, runtime: typeof edgeEsm) {
	let connectionString: string;
	let reference: PrismaClient;
	let schemaConfig: EdgeConfig;
	const clients: PrismaClient[] = [];
	const fixtureIds: string[] = [];

	beforeAll(async () => {
		const url = process.env.TEST_DATABASE_URL;
		if (!url || url === process.env.DATABASE_URL || !localSqlMetricsEnabled(url, "true"))
			throw new Error("ISOLATED_LOCAL_TEST_DATABASE_REQUIRED");
		connectionString = url;
		const template = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
		// Reuse the application's generated schema and compiler loader without editing
		// generated files. The clients under test execute the patched worker runtime.
		schemaConfig = {
			...(template as unknown as { _engineConfig: EdgeConfig })._engineConfig,
			engineVersion: "param-graph-cache-integration",
		};
		await template.$disconnect();
		const Reference = runtime.getPrismaClient(schemaConfig);
		reference = new Reference({
			adapter: new PrismaPg({ connectionString }),
		}) as unknown as PrismaClient;
	});
	afterEach(async () => {
		try {
			await reference.mediaAsset.deleteMany({ where: { id: { in: fixtureIds.splice(0) } } });
		} finally {
			await Promise.all(clients.splice(0).map((client) => client.$disconnect()));
		}
	});
	afterAll(() => reference?.$disconnect());

	function createClient(runtime: typeof edgeEsm, config = schemaConfig) {
		const Client = runtime.getPrismaClient(config);
		const client = new Client({
			adapter: new PrismaPg({ connectionString, max: 1 }),
		}) as unknown as PrismaClient;
		clients.push(client);
		return client;
	}

	async function fixtures() {
		const ownerId = `param-graph-cache-${crypto.randomUUID()}`;
		const ids = [crypto.randomUUID(), crypto.randomUUID()];
		fixtureIds.push(...ids);
		await reference.mediaAsset.createMany({
			data: ids.map((id, index) => ({
				id,
				ownerType: "USER",
				ownerId,
				kind: "INPUT",
				status: index === 0 ? "UPLOADING" : "VERIFYING",
				objectKey: `tests/${ownerId}/${id}.png`,
				mimeType: "image/png",
				byteSize: BigInt(index + 10),
				width: index + 10,
			})),
		});
		return { ids, ownerId };
	}

	function deferred<T = void>() {
		let resolve!: (value: T | PromiseLike<T>) => void;
		let reject!: (reason?: unknown) => void;
		const promise = new Promise<T>((done, failed) => {
			resolve = done;
			reject = failed;
		});
		return { promise, resolve, reject };
	}

	describe(`cached worker schema with real PostgreSQL (${entrypoint})`, () => {
		it("keeps interleaved model and batch parameters local to each client", async () => {
			const { ids, ownerId } = await fixtures();
			const first = createClient(runtime);
			const second = createClient(runtime);
			for (let round = 0; round < 3; round++) {
				const results = await Promise.all(
					[first, second].map((client, index) =>
						client.$transaction([
							client.mediaAsset.findUnique({
								where: { id: ids[index]! },
								select: { id: true, ownerId: true, byteSize: true },
							}),
							client.mediaAsset.findMany({
								where: { ownerId, byteSize: { gte: BigInt(index + 10) } },
								orderBy: { byteSize: "asc" },
								select: { id: true },
							}),
						]),
					),
				);
				for (const [index, result] of results.entries()) {
					expect(result[0]).toEqual({ id: ids[index], ownerId, byteSize: BigInt(index + 10) });
					expect(result[1]).toEqual(ids.slice(index).map((id) => ({ id })));
				}
			}
		});

		it("keeps enum lookup wrappers separate when clients share graph data", async () => {
			const { ids, ownerId } = await fixtures();
			const first = createClient(runtime);
			const swappedConfig: EdgeConfig = {
				...schemaConfig,
				inlineSchema: schemaConfig.inlineSchema.replace(
					"enum MediaAssetStatus {\n  UPLOADING\n  VERIFYING",
					'enum MediaAssetStatus {\n  UPLOADING @map("VERIFYING")\n  VERIFYING @map("UPLOADING")',
				),
				runtimeDataModel: {
					...schemaConfig.runtimeDataModel,
					enums: {
						...schemaConfig.runtimeDataModel.enums,
						MediaAssetStatus: {
							dbName: null,
							values: [
								{ name: "UPLOADING", dbName: "VERIFYING" },
								{ name: "VERIFYING", dbName: "UPLOADING" },
								{ name: "VERIFICATION_FAILED", dbName: null },
								{ name: "READY", dbName: null },
								{ name: "QUARANTINED", dbName: null },
								{ name: "DELETED", dbName: null },
							],
						},
					},
				},
			};
			expect(swappedConfig.inlineSchema).not.toBe(schemaConfig.inlineSchema);
			expect(swappedConfig.parameterizationSchema).toBe(schemaConfig.parameterizationSchema);
			const second = createClient(runtime, swappedConfig);
			const query = { where: { ownerId, status: "UPLOADING" as const }, select: { id: true } };
			await expect(first.mediaAsset.findMany(query)).resolves.toEqual([{ id: ids[0] }]);
			await expect(second.mediaAsset.findMany(query)).resolves.toEqual([{ id: ids[1] }]);
			await expect(first.mediaAsset.findMany(query)).resolves.toEqual([{ id: ids[0] }]);
		});

		it("preserves a second transaction and connection when the first client disconnects", async () => {
			const first = createClient(runtime);
			const second = createClient(runtime);
			const ready = [deferred<number>(), deferred<number>()];
			const release = [deferred(), deferred()];
			const pending = [first, second].map((client, index) => {
				const marker = `client-${index}-${crypto.randomUUID()}`;
				const transaction = client.$transaction(
					async (tx) => {
						const [row] = await tx.$queryRaw<Array<{ marker: string; pid: number }>>`
						SELECT set_config('ezpic.cache_probe', ${marker}, true) AS marker,
						pg_backend_pid() AS pid
					`;
						expect(row?.marker).toBe(marker);
						ready[index]!.resolve(row!.pid);
						await release[index]!.promise;
						await expect(tx.$queryRaw<Array<{ marker: string; pid: number }>>`
						SELECT current_setting('ezpic.cache_probe') AS marker, pg_backend_pid() AS pid
					`).resolves.toEqual([{ marker, pid: row!.pid }]);
					},
					{ timeout: 10_000 },
				);
				void transaction.catch(ready[index]!.reject);
				return transaction;
			});
			try {
				const pids = await Promise.all(ready.map((gate) => gate.promise));
				expect(new Set(pids).size).toBe(2);
				release[0]!.resolve();
				await pending[0];
				await first.$disconnect();
				release[1]!.resolve();
				await pending[1];
				await expect(second.$queryRaw`SELECT 42 AS value`).resolves.toEqual([{ value: 42 }]);
			} finally {
				for (const gate of release) gate.resolve();
				await Promise.allSettled(pending);
			}
		});

		it("rolls back one client's parameters without undoing another client's commit", async () => {
			const { ids } = await fixtures();
			const first = createClient(runtime);
			const second = createClient(runtime);
			const results = await Promise.allSettled([
				first.$transaction(async (tx) => {
					await tx.mediaAsset.update({ where: { id: ids[0]! }, data: { width: 101 } });
					throw new Error("EXPECTED_CACHE_PROBE_ROLLBACK");
				}),
				second.$transaction((tx) =>
					tx.mediaAsset.update({ where: { id: ids[1]! }, data: { width: 202 } }),
				),
			]);
			expect(results[0]).toMatchObject({
				status: "rejected",
				reason: new Error("EXPECTED_CACHE_PROBE_ROLLBACK"),
			});
			expect(results[1]?.status).toBe("fulfilled");
			await expect(
				reference.mediaAsset.findUnique({ where: { id: ids[0]! }, select: { width: true } }),
			).resolves.toEqual({ width: 10 });
			await expect(
				reference.mediaAsset.findUnique({ where: { id: ids[1]! }, select: { width: true } }),
			).resolves.toEqual({ width: 202 });
		});
	});
}
