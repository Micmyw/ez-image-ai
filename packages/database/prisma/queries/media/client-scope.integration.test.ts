import { afterEach, describe, expect, it, vi } from "vitest";

import { assertSafeDatabaseUrl } from "../../../../../tests/load/assert-safe-target";
import { createRuntimeDatabaseClient, db, runWithDatabaseClient } from "../../client";
import { getMediaDatabaseClient } from "./types";

afterEach(() => vi.unstubAllEnvs());

describe("request-owned PostgreSQL pools", () => {
	it("keeps concurrent real queries and transactions scoped and closes their pools", async () => {
		const url = assertSafeDatabaseUrl(process.env.TEST_DATABASE_URL);
		const clients = ["scope-first", "scope-second"].map((name) => {
			const connection = new URL(url);
			connection.searchParams.set("application_name", name);
			return createRuntimeDatabaseClient(connection.toString());
		});
		vi.stubEnv("EZPIC_RUNTIME", "workers");
		try {
			const names = await Promise.all(
				clients.map((client) =>
					runWithDatabaseClient(client, async () => {
						await getMediaDatabaseClient().$queryRaw`SELECT pg_sleep(0.02)::text`;
						return db.$transaction(async (transaction) => {
							const result = await transaction.$queryRaw<
								Array<{ name: string }>
							>`SELECT current_setting('application_name') AS name`;
							return result[0].name;
						});
					}),
				),
			);
			expect(names).toEqual(["scope-first", "scope-second"]);
			expect(() => getMediaDatabaseClient()).toThrow("DATABASE_REQUEST_SCOPE_REQUIRED");
		} finally {
			await Promise.all(clients.map((client) => client.$disconnect()));
		}
	});
});
