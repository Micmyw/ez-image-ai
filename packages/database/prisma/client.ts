import { AsyncLocalStorage } from "node:async_hooks";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "#prisma-runtime-client";

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

export function createRuntimeDatabaseClient(connectionString: string): PrismaClient {
	if (!connectionString) throw new Error("DATABASE_URL is not set");
	return new PrismaClient({
		adapter: new PrismaPg({
			connectionString,
			max: 1,
			connectionTimeoutMillis: 10_000,
			idleTimeoutMillis: 10_000,
		}),
	});
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
	return (runtimeGlobals.prisma ??= new PrismaClient({
		adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
	}));
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
