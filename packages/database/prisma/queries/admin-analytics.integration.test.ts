import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createRuntimeDatabaseClient, runWithDatabaseClient } from "../client";
import {
	getAdminAnalyticsFunnel,
	getAdminAnalyticsOverview,
	getAdminAnalyticsReport,
} from "./admin-analytics";

const connectionString =
	process.env.ADMIN_ANALYTICS_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const target = connectionString ? new URL(connectionString) : null;
const enabled = Boolean(
	target &&
	target.hostname === "127.0.0.1" &&
	["55432", "55439", "55441", "55442"].includes(target.port) &&
	/^\/(?:ezpic|admin|ai_media)_[a-z0-9_]*test$/.test(target.pathname),
);
if (connectionString && !enabled) throw new Error("ISOLATED_ADMIN_ANALYTICS_DATABASE_REQUIRED");

const prefix = `analytics-runtime-${randomUUID()}`;
const now = new Date("2026-10-20T12:00:00.000Z");
const day = 86_400_000;
const fixtures = [
	{ id: `${prefix}-recent`, createdAt: new Date("2026-10-20T19:55:00+08:00"), expected: 1 },
	{ id: `${prefix}-boundary`, createdAt: new Date(now.getTime() - day), expected: 1 },
	{ id: `${prefix}-old`, createdAt: new Date(now.getTime() - day - 1), expected: 0 },
	{ id: `${prefix}-future`, createdAt: new Date(now.getTime() + 1), expected: 0 },
];
let client: ReturnType<typeof createRuntimeDatabaseClient> | undefined;

describe.skipIf(!enabled)("admin analytics through the real Prisma runtime", () => {
	beforeAll(async () => {
		const runtimeTarget = new URL(target!.toString());
		// Deliberately use the timezone that exposed the browser fixture bug.
		// Prisma DateTime fields without @db.Timestamptz still store UTC values.
		runtimeTarget.searchParams.set("options", "-c timezone=Asia/Shanghai");
		client = createRuntimeDatabaseClient(runtimeTarget.toString());
		await client.user.createMany({
			data: fixtures.map(({ id, createdAt }) => ({
				id,
				name: "Isolated analytics fixture",
				email: `${id}@example.test`,
				emailVerified: true,
				createdAt,
				updatedAt: createdAt,
			})),
		});
	});

	afterAll(async () => {
		if (!client) return;
		try {
			await client.user.deleteMany({ where: { id: { in: fixtures.map(({ id }) => id) } } });
		} finally {
			await client.$disconnect();
		}
	});

	it("preserves the same UTC instant through Prisma model and raw SQL reads in a non-UTC session", async () => {
		const [setting] = await client!.$queryRawUnsafe<Array<{ timezone: string }>>(
			"SELECT current_setting('TimeZone') AS timezone",
		);
		expect(setting?.timezone).toBe("Asia/Shanghai");
		const recent = fixtures[0]!;
		const orm = await client!.user.findUniqueOrThrow({ where: { id: recent.id } });
		const [raw] = await client!.$queryRawUnsafe<
			Array<{ createdAt: Date; storedText: string; columnType: string }>
		>(
			`SELECT "createdAt", "createdAt"::text AS "storedText",
				pg_typeof("createdAt")::text AS "columnType" FROM "user" WHERE id = $1`,
			recent.id,
		);
		expect(raw?.columnType).toBe("timestamp without time zone");
		expect(raw?.storedText).toBe("2026-10-20 11:55:00");
		expect(orm.createdAt.toISOString()).toBe(recent.createdAt.toISOString());
		expect(raw?.createdAt.toISOString()).toBe(recent.createdAt.toISOString());
	});

	it("counts recent and exact-boundary registrations but excludes older and future timestamps", async () => {
		for (const fixture of fixtures) {
			const result = await runWithDatabaseClient(client!, () =>
				getAdminAnalyticsOverview({ scope: { kind: "user", userId: fixture.id }, now }),
			);
			expect(result.users).toEqual({ total: 1, new24h: fixture.expected });
		}
	});

	it("uses the same UTC registration instant for funnel cohorts and timezone-qualified reports", async () => {
		const scope = { kind: "user" as const, userId: fixtures[0]!.id };
		const funnel = await runWithDatabaseClient(client!, () =>
			getAdminAnalyticsFunnel({ scope, range: "24h", groupBy: "utm_source", now }),
		);
		expect(funnel.totals).toEqual({ signups: 1, checkouts: 0, paid: 0 });
		const report = await runWithDatabaseClient(client!, () =>
			getAdminAnalyticsReport({
				scope,
				from: new Date("2026-10-20T19:00:00+08:00"),
				to: new Date("2026-10-20T20:00:00+08:00"),
				now,
			}),
		);
		expect(report.current.users.new).toBe(1);
		expect(report.previous?.users.new).toBe(0);
	});
});
