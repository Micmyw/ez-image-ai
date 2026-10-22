import { AsyncLocalStorage } from "node:async_hooks";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "#prisma-runtime-client";

import {
	createDatabaseQueryMetrics,
	databaseQueryLogArgs,
	localSqlMetricsEnabled,
	type DatabaseQueryContext,
} from "./query-metrics";

export type { DatabaseQueryContext } from "./query-metrics";

// Next's server bundle and its outer Worker wrapper can contain separate copies
// of this module. The context must still be shared by both copies.
const contextKey = Symbol.for("ezpic.database.request-context");
const runtimeGlobals = globalThis as typeof globalThis & {
	[contextKey]?: AsyncLocalStorage<PrismaClient>;
	prisma?: PrismaClient;
};
const databaseContext = (runtimeGlobals[contextKey] ??= new AsyncLocalStorage<PrismaClient>());

export function runWithDatabaseClient<T>(client: PrismaClient, callback: () => T): T {
	return databaseContext.run(client, callback);
}

export function createRuntimeDatabaseClient(
	connectionString: string,
	diagnosticsContext?: DatabaseQueryContext,
): PrismaClient {
	if (!connectionString) throw new Error("DATABASE_URL is not set");
	return createClientWithLocalMetrics(
		connectionString,
		"request",
		{
			max: 1,
			connectionTimeoutMillis: 10_000,
			idleTimeoutMillis: 10_000,
		},
		diagnosticsContext,
	);
}

function createClientWithLocalMetrics(
	connectionString: string,
	clientKind: "request" | "node",
	poolOptions: { max?: number; connectionTimeoutMillis?: number; idleTimeoutMillis?: number } = {},
	diagnosticsContext?: DatabaseQueryContext,
): PrismaClient {
	if (
		!localSqlMetricsEnabled(connectionString, process.env.EZPIC_LOCAL_SQL_METRICS, {
			hyperdriveFlag: process.env.EZPIC_LOCAL_SQL_METRICS_HYPERDRIVE,
			originalConnectionString: process.env.DATABASE_URL,
		})
	)
		return new PrismaClient({ adapter: new PrismaPg({ connectionString, ...poolOptions }) });
	const metricsFormat = process.env.EZPIC_LOCAL_SQL_METRICS_FORMAT;
	const metrics = createDatabaseQueryMetrics({
		clientKind,
		context: diagnosticsContext,
		emit: (sample) => console.info(...databaseQueryLogArgs(sample, metricsFormat)),
	});
	const client = new PrismaClient({
		// A random local-only client identity lets PostgreSQL errors (including
		// COMMIT failures) join the existing metrics without logging SQL or inputs.
		// This is a startup parameter: it adds no query and changes no admission limit.
		adapter: new PrismaPg({
			connectionString,
			...poolOptions,
			application_name: metrics.snapshot().clientScope,
		}),
		log: [{ level: "query", emit: "event" }],
	});
	client.$on("query", metrics.observe);
	return client;
}

// The website Worker routes every accepted request through a database scope,
// including requests whose handler never queries the database. Constructing a
// PrismaClient allocates several MiB before any query runs, so materialize it
// on first real use and keep disposal of an unused scope allocation-free.
export function createLazyDatabaseClient(createClient: () => PrismaClient): PrismaClient {
	let client: PrismaClient | undefined;
	return new Proxy({} as PrismaClient, {
		get(_target, property) {
			if (!client) {
				// Thenable probes such as Promise.resolve must not allocate a
				// client, and an unused scope is disposed without creating one.
				if (property === "$disconnect") return () => Promise.resolve();
				if (property === "then") return undefined;
			}
			client ??= createClient();
			const value = Reflect.get(client, property, client);
			return typeof value === "function" ? value.bind(client) : value;
		},
	});
}

export function getDatabaseClient(): PrismaClient {
	const scoped = databaseContext.getStore();
	if (scoped) return scoped;
	if (process.env.EZPIC_RUNTIME === "workers") {
		throw new Error("DATABASE_REQUEST_SCOPE_REQUIRED");
	}
	if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
	return (runtimeGlobals.prisma ??= createClientWithLocalMetrics(process.env.DATABASE_URL, "node"));
}

// Preserve the existing import contract. Resolve at access time, never at
// module evaluation, so a request cannot reuse another request's socket pool.
export const db = new Proxy({} as PrismaClient, {
	get(_target, property) {
		const client = getDatabaseClient();
		const value = Reflect.get(client, property, client);
		return typeof value === "function" ? value.bind(client) : value;
	},
});
