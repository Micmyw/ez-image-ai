import { PrismaPg } from "@prisma/adapter-pg";
// The installed patch is JavaScript; it intentionally has no generated declarations.
// @ts-expect-error Test-only access to the actual installed runtime helper.
import * as helper from "@prisma/client/runtime/query-compiler-reuse.js";
import * as runtime from "@prisma/client/runtime/wasm-compiler-edge";

import { PrismaClient } from "../prisma/generated-worker/client";

type Scenario =
	| "isolation"
	| "validation"
	| "unknown"
	| "panic"
	| "value"
	| "reentry"
	| "oversized"
	| "unsupported";
type Config = Parameters<typeof runtime.getPrismaClient>[0];
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

function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
function same(actual: unknown, expected: unknown, message: string) {
	const encode = (value: unknown) =>
		JSON.stringify(value, (_, item) => (typeof item === "bigint" ? `${item}n` : item));
	check(
		encode(actual) === encode(expected),
		`${message}: ${encode(actual)} != ${encode(expected)}`,
	);
}
async function rejects(
	operation: PromiseLike<unknown>,
	pattern: RegExp,
	errorType?: typeof runtime.PrismaClientRustPanicError,
) {
	let caught: unknown;
	try {
		await operation;
	} catch (error) {
		caught = error;
	}
	check(
		caught instanceof Error && pattern.test(caught.message),
		`EXPECTED_REJECTION_${pattern}: ${String(caught)}`,
	);
	if (errorType) check(caught instanceof errorType, "EXPECTED_REAL_RUST_PANIC_ERROR");
}
const engine = (client: PrismaClient) => (client as unknown as { _engine: Engine })._engine;
const request = (ownerId: string): EngineRequest => ({
	modelName: "MediaAsset",
	action: "findMany",
	query: { arguments: { where: { ownerId } }, selection: { id: true } },
});

function factory(connectionString: string) {
	const compiler = {
		constructions: 0,
		compileCalls: 0,
		readCalls: 0,
		batchCalls: 0,
		freeCalls: 0,
		rawErrorCodes: [] as unknown[],
	};
	let injection: { plan: unknown } | { error: unknown; panic?: boolean } | undefined;
	let observedConstructor: unknown;
	const template = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 1 }) });
	const source = (template as unknown as { _engineConfig: Config })._engineConfig;
	const wasm = source.compilerWasm!;
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
						if (JSON.parse(args[0]).action?.startsWith("find")) compiler.readCalls++;
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
								).PRISMA_WASM_PANIC_REGISTRY.set_message("EXPECTED_QUERY_PLAN_WORKER_PANIC");
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
	const Client = runtime.getPrismaClient(config);
	const clients: PrismaClient[] = [template];
	return {
		compiler,
		inject(value: typeof injection) {
			injection = value;
		},
		disable() {
			helper.hardDisableQueryCompilerReuse(observedConstructor);
		},
		create(disabled = false) {
			const sql = { count: 0 };
			const adapter = new PrismaPg({ connectionString, max: 1 });
			const connect = adapter.connect.bind(adapter);
			adapter.connect = async () => {
				const connection = await connect();
				const wrap = <T extends Pick<typeof connection, "queryRaw" | "executeRaw">>(
					queryable: T,
				) => {
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
			const client = new Client({
				adapter,
				...(disabled ? { queryPlanCacheMaxSize: 0 } : {}),
			}) as unknown as PrismaClient;
			clients.push(client);
			return { client, sql };
		},
		async disconnect() {
			await Promise.all(clients.map((client) => client.$disconnect()));
		},
	};
}

export default {
	async fetch(
		httpRequest: Request,
		env: {
			HYPERDRIVE: { connectionString: string };
			TEST_RUN_LABEL: string;
			TEST_SCENARIO: Scenario;
		},
	) {
		if (httpRequest.method !== "POST") return new Response("Method not allowed", { status: 405 });
		const scenario = env.TEST_SCENARIO;
		const observed = factory(env.HYPERDRIVE.connectionString);
		const first = observed.create();
		const second = observed.create();
		const { compiler } = observed;
		const ownerA = `plan-workerd-${env.TEST_RUN_LABEL}-${crypto.randomUUID()}`;
		const ownerB = `plan-workerd-${env.TEST_RUN_LABEL}-${crypto.randomUUID()}`;
		const coverage: string[] = [];
		const create = (
			client: PrismaClient,
			ownerId: string,
			width: number | null,
			kind: "INPUT" | "OUTPUT" = "INPUT",
		) =>
			client.mediaAsset.create({
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
		const read = (client: PrismaClient, ownerId: string) =>
			client.mediaAsset.findMany({ where: { ownerId }, select: { id: true } });
		try {
			await first.client.$connect();
			const b = await create(second.client, ownerB, 22, "OUTPUT");
			if (scenario === "isolation") {
				const a = await create(first.client, ownerA, 11);
				const query = (
					client: Pick<PrismaClient, "mediaAsset">,
					ownerId: string,
					minimum: bigint,
				) =>
					client.mediaAsset.findMany({
						where: { ownerId, byteSize: { gte: minimum } },
						select: { id: true, ownerId: true, width: true, byteSize: true },
					});
				let compiled = compiler.compileCalls;
				const left = await query(first.client, ownerA, 11n);
				same(left, [{ id: a.id, ownerId: ownerA, width: 11, byteSize: 11n }], "LEFT_RESULT");
				left[0]!.ownerId = "mutated-result";
				same(
					await query(second.client, ownerB, 22n),
					[{ id: b.id, ownerId: ownerB, width: 22, byteSize: 22n }],
					"RIGHT_RESULT",
				);
				same(await query(first.client, ownerA, 12n), [], "PRIVATE_HIT_PARAMETERS");
				same(
					await query(first.client, ownerA, 1n),
					[{ id: a.id, ownerId: ownerA, width: 11, byteSize: 11n }],
					"RESULT_MUTATION_LEAK",
				);
				check(compiler.compileCalls - compiled === 1, "SINGLE_READ_NOT_SHARED");
				coverage.push("cross-client/private-hit/parameter/result-isolation");
				const disabled = observed.create(true);
				compiled = compiler.compileCalls;
				for (let i = 0; i < 2; i++)
					same(
						await query(disabled.client, ownerA, 11n),
						[{ id: a.id, ownerId: ownerA, width: 11, byteSize: 11n }],
						"DISABLED_CLIENT_RESULT",
					);
				check(compiler.compileCalls - compiled === 2, "DISABLED_CLIENT_USED_SHARED_PLAN");
				coverage.push("queryPlanCacheMaxSize=0");
				const aNull = await create(first.client, ownerA, null);
				const bNull = await create(second.client, ownerB, null);
				const nullable = (client: PrismaClient, ownerId: string) =>
					client.mediaAsset.findMany({
						where: { ownerId, width: null },
						select: { id: true, width: true },
					});
				compiled = compiler.compileCalls;
				same(await nullable(first.client, ownerA), [{ id: aNull.id, width: null }], "NULL_LEFT");
				same(await nullable(second.client, ownerB), [{ id: bNull.id, width: null }], "NULL_RIGHT");
				check(compiler.compileCalls - compiled === 1, "NULL_READ_NOT_SHARED");
				const enumeration = (client: PrismaClient, ownerId: string, kind: "INPUT" | "OUTPUT") =>
					client.mediaAsset.findMany({
						where: { ownerId, kind, width: { not: null } },
						select: { id: true, kind: true },
					});
				compiled = compiler.compileCalls;
				same(
					await enumeration(first.client, ownerA, "INPUT"),
					[{ id: a.id, kind: "INPUT" }],
					"ENUM_LEFT",
				);
				same(
					await enumeration(second.client, ownerB, "OUTPUT"),
					[{ id: b.id, kind: "OUTPUT" }],
					"ENUM_RIGHT",
				);
				// Native parameterization retains enum literals in distinct keys.
				check(compiler.compileCalls - compiled === 2, "ENUM_KEYS_MUST_REMAIN_DISTINCT");
				same(
					await enumeration(first.client, ownerB, "OUTPUT"),
					[{ id: b.id, kind: "OUTPUT" }],
					"ENUM_SHARED_OUTPUT",
				);
				same(
					await enumeration(second.client, ownerA, "INPUT"),
					[{ id: a.id, kind: "INPUT" }],
					"ENUM_SHARED_INPUT",
				);
				check(compiler.compileCalls - compiled === 2, "IDENTICAL_ENUM_KEY_NOT_SHARED");
				const cursor = (client: PrismaClient, ownerId: string, id: string) =>
					client.mediaAsset.findMany({
						where: { ownerId },
						cursor: { id },
						take: 1,
						skip: 0,
						orderBy: { id: "asc" },
						select: { id: true },
					});
				compiled = compiler.compileCalls;
				same(await cursor(first.client, ownerA, a.id), [{ id: a.id }], "CURSOR_LEFT");
				same(await cursor(second.client, ownerB, b.id), [{ id: b.id }], "CURSOR_RIGHT");
				check(compiler.compileCalls - compiled === 1, "CURSOR_READ_NOT_SHARED");
				coverage.push("null/enums/cursor");
				compiled = compiler.compileCalls;
				same(
					await first.client.mediaAsset.findUnique({
						where: { id: a.id },
						select: { ownerId: true, width: true },
					}),
					{ ownerId: ownerA, width: 11 },
					"FIND_UNIQUE_LEFT",
				);
				same(
					await second.client.mediaAsset.findUnique({
						where: { id: b.id },
						select: { ownerId: true, width: true },
					}),
					{ ownerId: ownerB, width: 22 },
					"FIND_UNIQUE_RIGHT",
				);
				same(
					await second.client.mediaAsset.findUnique({
						where: { id: "query-plan-missing" },
						select: { ownerId: true, width: true },
					}),
					null,
					"FIND_UNIQUE_MISSING",
				);
				check(compiler.compileCalls - compiled === 1, "FIND_UNIQUE_NOT_SHARED");
				compiled = compiler.compileCalls;
				same(
					await first.client.mediaAsset.findUniqueOrThrow({
						where: { id: a.id },
						select: { ownerId: true },
					}),
					{ ownerId: ownerA },
					"UNIQUE_LEFT",
				);
				same(
					await second.client.mediaAsset.findUniqueOrThrow({
						where: { id: b.id },
						select: { ownerId: true },
					}),
					{ ownerId: ownerB },
					"UNIQUE_RIGHT",
				);
				await rejects(
					first.client.mediaAsset.findUniqueOrThrow({
						where: { id: "query-plan-missing" },
						select: { ownerId: true },
					}),
					/No record|not found|Expected a record/i,
				);
				check(compiler.compileCalls - compiled === 1, "UNIQUE_THROW_NOT_SHARED");
				compiled = compiler.compileCalls;
				same(
					await first.client.mediaAsset.findFirstOrThrow({
						where: { ownerId: ownerA, width: 11 },
						select: { id: true },
					}),
					{ id: a.id },
					"FIRST_LEFT",
				);
				same(
					await second.client.mediaAsset.findFirstOrThrow({
						where: { ownerId: ownerB, width: 22 },
						select: { id: true },
					}),
					{ id: b.id },
					"FIRST_RIGHT",
				);
				await rejects(
					second.client.mediaAsset.findFirstOrThrow({
						where: { ownerId: "query-plan-missing", width: 22 },
						select: { id: true },
					}),
					/No record|not found|Expected a record/i,
				);
				check(compiler.compileCalls - compiled === 1, "FIRST_THROW_NOT_SHARED");
				coverage.push("findUnique/findUniqueOrThrow/findFirstOrThrow/missing-row");
				const pids: number[] = [];
				let ready = 0;
				let release!: () => void;
				const barrier = new Promise<void>((resolve) => {
					release = resolve;
				});
				const readsBefore = compiler.readCalls;
				const pending = [first, second].map(({ client }, index) =>
					client
						.$transaction(
							async (tx) => {
								const ownerId = index === 0 ? ownerA : ownerB;
								const [row] = await tx.$queryRaw<
									Array<{ marker: string; pid: number }>
								>`SELECT set_config('ezpic.plan_worker_probe', ${ownerId}, true) AS marker, pg_backend_pid() AS pid`;
								check(row!.marker === ownerId, "TX_MARKER_LEAK");
								pids.push(row!.pid);
								if (++ready === 2) release();
								await barrier;
								const result = await query(tx, ownerId, index === 0 ? 11n : 22n);
								check(result.length === 1 && result[0]!.ownerId === ownerId, "TX_PLAN_OWNER_LEAK");
								await tx.mediaAsset.update({
									where: { id: index === 0 ? a.id : b.id },
									data: { width: index === 0 ? 111 : 222 },
								});
								same(
									await tx.$queryRaw<
										Array<{ marker: string; pid: number }>
									>`SELECT current_setting('ezpic.plan_worker_probe') AS marker, pg_backend_pid() AS pid`,
									[{ marker: ownerId, pid: row!.pid }],
									"TX_SESSION_LEAK",
								);
								if (index === 0) throw new Error("EXPECTED_WORKER_PLAN_ROLLBACK");
							},
							{ timeout: 10_000 },
						)
						.catch((error: unknown) => {
							release();
							throw error;
						}),
				);
				const outcomes = await Promise.allSettled(pending);
				check(
					outcomes[0]?.status === "rejected" && outcomes[1]?.status === "fulfilled",
					"TX_OUTCOMES",
				);
				check(
					new Set(pids).size === 2 && compiler.readCalls === readsBefore,
					"TX_READ_OR_SESSION_SHARED",
				);
				check((await query(first.client, ownerA, 11n))[0]!.width === 11, "ROLLBACK_LOST");
				check((await query(second.client, ownerB, 22n))[0]!.width === 222, "COMMIT_LOST");
				coverage.push("independent-transactions/rollback/session-local-read");
				check(compiler.constructions === 1 && compiler.freeCalls === 0, "COMPILER_LIFETIME");
			} else if (scenario === "value") {
				observed.inject({ plan: { type: "value", args: [{ nested: { marker: "original" } }] } });
				const compiled = compiler.compileCalls;
				const sql = first.sql.count + second.sql.count;
				const left = await engine(second.client).request(request(ownerB), {});
				left.data.findMany[0]!.nested.marker = "mutated";
				const privateHit = await engine(second.client).request(request(ownerB), {});
				const sharedHit = await engine(first.client).request(request(ownerA), {});
				same(
					privateHit.data.findMany,
					[{ nested: { marker: "original" } }],
					"INJECTED_VALUE_PRIVATE_MUTATION",
				);
				same(
					sharedHit.data.findMany,
					[{ nested: { marker: "original" } }],
					"INJECTED_VALUE_SHARED_MUTATION",
				);
				check(
					privateHit.data.findMany[0] !== sharedHit.data.findMany[0],
					"INJECTED_VALUE_OBJECT_SHARED",
				);
				check(
					compiler.compileCalls - compiled === 1 && first.sql.count + second.sql.count === sql,
					"INJECTED_VALUE_PATH",
				);
				coverage.push("explicitly-injected-value-plan/real-engine/interpreter/private-hit-clone");
			} else {
				if (scenario === "oversized" || scenario === "unsupported") {
					observed.inject({
						plan: {
							type: "value",
							args: [
								{ nested: { marker: scenario === "oversized" ? "x".repeat(70_000) : undefined } },
							],
						},
					});
					await engine(second.client).request(request(ownerB), {});
				} else same(await read(second.client, ownerB), [{ id: b.id }], "WARM_B_FIRST");
				const compiled = compiler.compileCalls;
				const constructions = compiler.constructions;
				const sql = first.sql.count + second.sql.count;
				if (scenario === "reentry") {
					let hooks = 0;
					await rejects(
						engine(second.client).request(request(ownerB), {
							customDataProxyFetch(fetch) {
								hooks++;
								observed.disable();
								return fetch;
							},
						}),
						/QUERY_COMPILER_REUSE_DISABLED/,
					);
					check(
						hooks === 1 &&
							compiler.compileCalls === compiled &&
							first.sql.count + second.sql.count === sql,
						"FINAL_HANDOFF_GATE_BYPASSED",
					);
					coverage.push("synchronous-customFetch-reentry/private-hit/final-gate/no-adapter-sql");
				} else {
					if (scenario === "validation") {
						await rejects(
							first.client.mediaAsset.findMany({
								where: { ownerId: ownerA },
								select: { id: true, deliberatelyUnknownCompilerField: true } as never,
							}),
							/deliberatelyUnknownCompilerField|Unknown field/,
						);
						check(compiler.rawErrorCodes.includes("P2009"), "REAL_WASM_P2009_REQUIRED");
					} else {
						observed.inject(
							scenario === "panic"
								? {
										panic: true,
										error: {
											message: "validation-shaped",
											code: "P2009",
											meta: { kind: "UnknownSelectionField" },
										},
									}
								: { error: new Error("EXPECTED_UNKNOWN_QUERY_PLAN_COMPILE") },
						);
						await rejects(
							first.client.mediaAsset.findMany({
								where: { ownerId: ownerA },
								select: { width: true },
							}),
							scenario === "panic"
								? /EXPECTED_QUERY_PLAN_WORKER_PANIC/
								: /EXPECTED_UNKNOWN_QUERY_PLAN_COMPILE/,
							scenario === "panic" ? runtime.PrismaClientRustPanicError : undefined,
						);
					}
					check(
						compiler.compileCalls - compiled === 1 && first.sql.count + second.sql.count === sql,
						"FAILED_COMPILE_RETRIED_OR_EXECUTED",
					);
					if (scenario === "validation") {
						same(await read(second.client, ownerB), [{ id: b.id }], "SOFT_FALLBACK_RESULT");
						check(
							compiler.compileCalls - compiled === 2 &&
								compiler.constructions - constructions === 1 &&
								first.sql.count + second.sql.count > sql,
							"WARM_PRIVATE_PLAN_DID_NOT_FALL_BACK",
						);
						coverage.push("real-P2009/warm-B/one-explicit-private-fallback/no-automatic-retry");
					} else {
						await rejects(
							engine(second.client).request(request(ownerB), {}),
							/QUERY_COMPILER_REUSE_DISABLED/,
						);
						check(
							compiler.compileCalls - compiled === 1 &&
								compiler.constructions === constructions &&
								first.sql.count + second.sql.count === sql,
							"HARD_DISABLE_BYPASSED",
						);
						coverage.push(`${scenario}/warm-B/hard-disable/no-adapter-sql/no-automatic-retry`);
					}
				}
			}
			return Response.json({
				passed: true,
				scenario,
				coverage,
				compiler: { ...compiler },
				adapterSql: first.sql.count + second.sql.count,
			});
		} catch (error) {
			return Response.json(
				{
					passed: false,
					scenario,
					coverage,
					compiler: { ...compiler },
					error: error instanceof Error ? error.message : String(error),
				},
				{ status: 500 },
			);
		} finally {
			observed.inject(undefined);
			try {
				// A new facade after hard invalidation takes the original independent
				// compiler path; cleanup never retries the failed paid/query operation.
				await observed
					.create()
					.client.mediaAsset.deleteMany({ where: { ownerId: { in: [ownerA, ownerB] } } });
			} finally {
				await observed.disconnect();
			}
		}
	},
};
