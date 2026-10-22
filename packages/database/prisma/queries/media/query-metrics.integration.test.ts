import { afterEach, describe, expect, it, vi } from "vitest";

import { createRuntimeDatabaseClient } from "../../client";
import { localSqlMetricsEnabled } from "../../query-metrics";

function isolatedUrl(): string {
	const value = process.env.TEST_DATABASE_URL;
	if (!value || value === process.env.DATABASE_URL || !localSqlMetricsEnabled(value, "true"))
		throw new Error("ISOLATED_LOCAL_TEST_DATABASE_REQUIRED");
	return value;
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("local Prisma query metrics hook", () => {
	it("captures numeric events for real local reads including a transaction without SQL or parameters", async () => {
		vi.stubEnv("EZPIC_LOCAL_SQL_METRICS", "true");
		const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const client = createRuntimeDatabaseClient(isolatedUrl());
		const marker = "private-fixture-parameter-not-for-metrics";
		let applicationName: string | undefined;
		try {
			const [connection] = await client.$queryRaw<Array<{ applicationName: string }>>`
				SELECT current_setting('application_name') AS "applicationName"
			`;
			applicationName = connection?.applicationName;
			await expect(
				client.$queryRaw<Array<{ marker: string }>>`SELECT ${marker}::text AS marker`,
			).resolves.toEqual([{ marker }]);
			await client.$transaction(async (tx) => {
				await tx.$queryRaw`SELECT 1 AS fixture_read`;
			});
		} finally {
			await client.$disconnect();
		}
		const samples = log.mock.calls
			.filter(([event]) => event === "media.database.query")
			.map(([, sample]) => sample);
		// Prisma's adapter event stream need not expose every BEGIN/COMMIT command.
		expect(samples.length).toBeGreaterThanOrEqual(2);
		for (const sample of samples) {
			expect(Object.keys(sample).sort()).toEqual([
				"at",
				"clientScope",
				"completedAt",
				"durationMs",
				"startedAt",
			]);
			expect(sample.durationMs).toBeGreaterThanOrEqual(0);
			expect(sample.completedAt - sample.startedAt).toBeCloseTo(sample.durationMs, 2);
			expect(sample.clientScope).toMatch(/^request:[a-f0-9-]{36}$/);
		}
		expect(new Set(samples.map((sample) => sample.clientScope)).size).toBe(1);
		expect(applicationName).toBe(samples[0]!.clientScope);
		const serialized = JSON.stringify(samples);
		for (const privateValue of [
			marker,
			"SELECT",
			"postgresql:",
			"foundation_test",
			"params",
			"query",
		])
			expect(serialized).not.toContain(privateValue);
	});

	it("does not emit query diagnostics without the explicit flag", async () => {
		vi.stubEnv("EZPIC_LOCAL_SQL_METRICS", "false");
		vi.stubEnv("PGAPPNAME", "fixture-existing-application-name");
		const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const client = createRuntimeDatabaseClient(isolatedUrl());
		try {
			await expect(
				client.$queryRaw<Array<{ applicationName: string }>>`
					SELECT current_setting('application_name') AS "applicationName"
				`,
			).resolves.toEqual([{ applicationName: "fixture-existing-application-name" }]);
		} finally {
			await client.$disconnect();
		}
		expect(log.mock.calls.filter(([event]) => event === "media.database.query")).toEqual([]);
	});

	it("attributes interleaved real queries by fixed client identities, independent of completion time", async () => {
		vi.stubEnv("EZPIC_LOCAL_SQL_METRICS", "true");
		const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const identities = [
			{
				runId: "run-first",
				taskId: "media-verify-upload",
				jobId: "job-first",
				assetId: "asset-first",
			},
			{ runId: "run-second", taskId: "media-finalize-generation", jobId: "job-second" },
		];
		const clients = identities.map((context) =>
			createRuntimeDatabaseClient(isolatedUrl(), context),
		);
		try {
			await Promise.all(
				clients.map(async (client, index) => {
					await client.$transaction(async (tx) => {
						await tx.$executeRaw`SELECT pg_sleep(${index === 0 ? 0.05 : 0.01})`;
						await tx.$queryRaw`SELECT 1 AS fixture_read`;
					});
				}),
			);
		} finally {
			await Promise.all(clients.map((client) => client.$disconnect()));
		}
		const samples = log.mock.calls
			.filter(([event]) => event === "media.database.query")
			.map(([, sample]) => sample);
		const scopes = new Map<string, string>();
		for (const context of identities) {
			const matching = samples.filter((sample) => sample.runId === context.runId);
			expect(matching.length).toBeGreaterThanOrEqual(2);
			const clientScopes = new Set<string>(matching.map((sample) => sample.clientScope));
			expect(clientScopes.size).toBe(1);
			scopes.set(context.runId, [...clientScopes][0]!);
			for (const sample of matching) expect(sample).toMatchObject(context);
		}
		expect(new Set(scopes.values()).size).toBe(2);
		expect(
			samples.every((sample) => identities.some((value) => value.runId === sample.runId)),
		).toBe(true);
	});
});
