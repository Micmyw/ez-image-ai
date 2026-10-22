import { PrismaPg } from "@prisma/adapter-pg";
import * as runtime from "@prisma/client/runtime/wasm-compiler-edge";

import { PrismaClient } from "../prisma/generated-worker/client";

const compiler = { constructions: 0, compileCalls: 0, batchCalls: 0, freeCalls: 0 };

function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function instrumentedClient(connectionString: string) {
	const template = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 1 }) });
	type Config = Parameters<typeof runtime.getPrismaClient>[0];
	const source = (template as unknown as { _engineConfig: Config })._engineConfig;
	const wasm = source.compilerWasm!;
	// Keep only schema/loader configuration: no client, adapter, pool or transaction
	// from this template enters the class shared by the test's independent clients.
	const config: Config = {
		clientVersion: source.clientVersion,
		engineVersion: source.engineVersion,
		activeProvider: source.activeProvider,
		previewFeatures: source.previewFeatures,
		inlineSchema: source.inlineSchema,
		runtimeDataModel: source.runtimeDataModel,
		parameterizationSchema: source.parameterizationSchema,
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
						return super.compile(...args);
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
				return { ...loaded, QueryCompiler: ObservedCompiler };
			},
		},
	};
	const Client = runtime.getPrismaClient(config);
	return {
		template,
		create: () =>
			new Client({
				adapter: new PrismaPg({ connectionString, max: 1 }),
			}) as unknown as PrismaClient,
	};
}

export default {
	async fetch(
		request: Request,
		env: { HYPERDRIVE: { connectionString: string }; TEST_RUN_LABEL: string },
	) {
		if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
		const ownerA = `compiler-workerd-${env.TEST_RUN_LABEL}-${crypto.randomUUID()}`;
		const ownerB = `compiler-workerd-${env.TEST_RUN_LABEL}-${crypto.randomUUID()}`;
		const factory = instrumentedClient(env.HYPERDRIVE.connectionString);
		const first = factory.create();
		const second = factory.create();
		try {
			const make = (client: PrismaClient, ownerId: string, width: number) =>
				client.mediaAsset.create({
					data: {
						ownerType: "USER",
						ownerId,
						kind: "INPUT",
						objectKey: `tests/${ownerId}/asset.png`,
						mimeType: "image/png",
						byteSize: BigInt(width),
						width,
					},
				});
			const [a, b] = await Promise.all([make(first, ownerA, 11), make(second, ownerB, 22)]);
			check(a.id !== b.id, "DYNAMIC_IDS_MUST_DIFFER");
			const [left, right] = await Promise.all([
				first.$transaction([
					first.mediaAsset.findMany({
						where: { ownerId: ownerA },
						select: { ownerId: true, width: true },
					}),
					first.$queryRaw<Array<{ marker: string }>>`SELECT ${ownerA}::text AS marker`,
				]),
				second.$transaction([
					second.$queryRaw<Array<{ marker: string }>>`SELECT ${ownerB}::text AS marker`,
					second.mediaAsset.findUnique({
						where: { id: b.id },
						select: { id: true, byteSize: true },
					}),
				]),
			]);
			check(
				left[0].length === 1 && left[0][0]?.ownerId === ownerA && left[0][0]?.width === 11,
				"LEFT_OWNER_OR_PLAN_LEAK",
			);
			check(left[1][0]?.marker === ownerA && right[0][0]?.marker === ownerB, "RAW_PARAMETERS_LEAK");
			check(right[1]?.id === b.id && right[1]?.byteSize === 22n, "RIGHT_OWNER_OR_PLAN_LEAK");
			const outcomes = await Promise.allSettled([
				first.$transaction(async (tx) => {
					await tx.mediaAsset.update({ where: { id: a.id }, data: { width: 111 } });
					throw new Error("EXPECTED_WORKER_ROLLBACK");
				}),
				second.$transaction((tx) =>
					tx.mediaAsset.update({ where: { id: b.id }, data: { width: 222 } }),
				),
			]);
			check(
				outcomes[0]?.status === "rejected" && outcomes[1]?.status === "fulfilled",
				"TRANSACTIONS_NOT_INDEPENDENT",
			);
			const values = await second.mediaAsset.findMany({
				where: { id: { in: [a.id, b.id] } },
				select: { id: true, width: true },
			});
			check(values.find((row) => row.id === a.id)?.width === 11, "ROLLBACK_LOST");
			check(values.find((row) => row.id === b.id)?.width === 222, "COMMIT_LOST");
			await first.$disconnect();
			check(
				(await second.mediaAsset.findUnique({ where: { id: b.id } }))?.ownerId === ownerB,
				"OTHER_CLIENT_DISCONNECT_LEAK",
			);
			check(compiler.constructions === 1, "REAL_COMPILER_NOT_REUSED");
			check(compiler.freeCalls === 0, "SHARED_COMPILER_FREED");
			return Response.json({
				passed: true,
				compiler: { ...compiler },
				ids: [a.id, b.id],
				createdAt: [a.createdAt, b.createdAt],
			});
		} catch (error) {
			return Response.json(
				{
					passed: false,
					error: error instanceof Error ? error.message : String(error),
					compiler: { ...compiler },
				},
				{ status: 500 },
			);
		} finally {
			try {
				await second.mediaAsset.deleteMany({ where: { ownerId: { in: [ownerA, ownerB] } } });
			} finally {
				await Promise.all([
					first.$disconnect(),
					second.$disconnect(),
					factory.template.$disconnect(),
				]);
			}
		}
	},
};
