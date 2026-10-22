import { describe, expect, it } from "vitest";

import { PrismaClient, type Prisma } from "./generated/client";

type Adapter = NonNullable<Prisma.PrismaClientOptions["adapter"]>;
type Driver = Awaited<ReturnType<Adapter["connect"]>>;
type Query = Parameters<Driver["executeRaw"]>[0];

async function captureInsert(method: "create" | "createMany", availableAt?: Date) {
	const queries: Query[] = [];
	const capture = async (query: Query): Promise<never> => {
		queries.push(query);
		// The real compiler runs; this adapter records SQL and never connects to a database.
		throw new Error("SQL_CAPTURE_ONLY");
	};
	const driver: Driver = {
		provider: "postgres",
		adapterName: "outbox-default-regression",
		queryRaw: capture,
		executeRaw: capture,
		executeScript: async () => undefined,
		dispose: async () => undefined,
		getConnectionInfo: () => ({ supportsRelationJoins: true }),
		startTransaction: async () => ({
			...driver,
			commit: async () => undefined,
			rollback: async () => undefined,
			options: { usePhantomQuery: true },
		}),
	};
	const client = new PrismaClient({
		adapter: {
			provider: "postgres",
			adapterName: driver.adapterName,
			connect: async () => driver,
		},
	});
	const data = {
		id: "outbox-default-regression",
		eventType: "MEDIA_ASSET_VERIFY",
		aggregateType: "MEDIA_ASSET",
		aggregateId: "asset-default-regression",
		dedupeKey: "outbox-default-regression",
		payload: { assetId: "asset-default-regression" },
		...(availableAt ? { availableAt } : {}),
	};
	try {
		await expect(
			method === "create"
				? client.outboxEvent.create({ data })
				: client.outboxEvent.createMany({ data, skipDuplicates: true }),
		).rejects.toThrow("SQL_CAPTURE_ONLY");
	} finally {
		await client.$disconnect();
	}
	expect(queries).toHaveLength(1);
	return queries[0]!;
}

describe.each(["create", "createMany"] as const)("Outbox availability default (%s)", (method) => {
	it("leaves a new immediate event's availability to the PostgreSQL default", async () => {
		const query = await captureInsert(method);
		const columns = query.sql.slice(0, query.sql.indexOf(" VALUES"));
		expect(columns).not.toContain('"availableAt"');
		// This change deliberately preserves the existing creation timestamp contract.
		expect(columns).toContain('"createdAt"');
	});

	it("preserves an explicit future due time as a bound parameter", async () => {
		const due = new Date("2099-01-02T03:04:05.678Z");
		const query = await captureInsert(method, due);
		const columns = query.sql.slice(0, query.sql.indexOf(" VALUES"));
		expect(columns).toContain('"availableAt"');
		expect(
			query.args.some(
				(value) =>
					(value instanceof Date || typeof value === "string") &&
					new Date(value).getTime() === due.getTime(),
			),
		).toBe(true);
	});
});
