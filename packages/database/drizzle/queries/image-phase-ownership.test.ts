import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as prisma from "../../prisma/queries/media/image-phase-ownership";
import type { ImagePhaseLease } from "../../shared/image-phase-ownership";
import * as drizzle from "./image-phase-ownership";

const now = new Date("2026-10-22T10:00:00.000Z");
const phase = { kind: "verification", assetId: "asset-1", generation: 7 } as const;
const owner = {
	workflowId: "workflow-1",
	phaseKey: "10000000-0000-4000-8000-000000000001",
	epoch: 4,
};
const lease: ImagePhaseLease = { ...owner, leasedUntil: new Date(now.getTime() + 30_000) };
const uuid = "20000000-0000-4000-8000-000000000001";

type Adapter = "Prisma" | "Drizzle";
type Call = { sql: string; params: unknown[] };

// Only SQL construction and returned-record handling are exercised here. This
// does not execute PostgreSQL, acquire database locks or certify cleanup races.
function harness(adapter: Adapter, responses: Record<string, unknown>[][], changes = [1]) {
	const calls: Call[] = [];
	const record = (sql: string, params: unknown[]) => {
		calls.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
	};
	if (adapter === "Prisma") {
		const capture = (strings: TemplateStringsArray, params: unknown[]) => {
			const sql = strings.reduce(
				(text, part, index) => text + (index ? `$${index}` : "") + part,
				"",
			);
			record(sql, params);
		};
		const tx = {
			$queryRaw: vi.fn(async (strings: TemplateStringsArray, ...params: unknown[]) => {
				capture(strings, params);
				return responses.shift() ?? [];
			}),
			$executeRaw: vi.fn(async (strings: TemplateStringsArray, ...params: unknown[]) => {
				capture(strings, params);
				return changes.shift() ?? 0;
			}),
		} as unknown as Parameters<typeof prisma.claimImagePhaseOwnerInTransaction>[1];
		return {
			calls,
			claim: (input: Parameters<typeof prisma.claimImagePhaseOwnerInTransaction>[0]) =>
				prisma.claimImagePhaseOwnerInTransaction(input, tx),
			get: (input: Parameters<typeof prisma.getImagePhaseOwner>[0]) =>
				prisma.getImagePhaseOwner(input, tx),
			current: (input: Parameters<typeof prisma.isImagePhaseOwnerCurrent>[0], receipt = owner) =>
				prisma.isImagePhaseOwnerCurrent(input, receipt, tx),
			cleanup: (limit: number) => prisma.deleteExpiredImagePhaseOwners({ limit }, tx),
			wait: (includeProcessingLease = true) =>
				prisma.getProviderEventDeliveryWait(
					{ eventId: "event", attemptId: "attempt", includeProcessingLease },
					tx,
				),
		};
	}
	const dialect = new PgDialect();
	const tx = {
		execute: vi.fn(async (statement: SQL) => {
			const query = dialect.sqlToQuery(statement);
			record(query.sql, query.params);
			if (/^\s*(INSERT|UPDATE)\b/i.test(query.sql)) {
				const count = changes.shift() ?? 0;
				return { rows: Array.from({ length: count }, () => ({ phaseKey: uuid })), rowCount: count };
			}
			const rows = responses.shift() ?? [];
			return { rows, rowCount: rows.length };
		}),
	} as unknown as Parameters<typeof drizzle.claimImagePhaseOwnerInTransaction>[1];
	return {
		calls,
		claim: (input: Parameters<typeof drizzle.claimImagePhaseOwnerInTransaction>[0]) =>
			drizzle.claimImagePhaseOwnerInTransaction(input, tx),
		get: (input: Parameters<typeof drizzle.getImagePhaseOwner>[0]) =>
			drizzle.getImagePhaseOwner(input, tx),
		current: (input: Parameters<typeof drizzle.isImagePhaseOwnerCurrent>[0], receipt = owner) =>
			drizzle.isImagePhaseOwnerCurrent(input, receipt, tx),
		cleanup: (limit: number) => drizzle.deleteExpiredImagePhaseOwners({ limit }, tx),
		wait: (includeProcessingLease = true) =>
			drizzle.getProviderEventDeliveryWait(
				{ eventId: "event", attemptId: "attempt", includeProcessingLease },
				tx,
			),
	};
}

afterEach(() => vi.restoreAllMocks());

describe.each(["Prisma", "Drizzle"] as const)(
	"%s phase ownership persistence contract",
	(adapter) => {
		it.each([true, false])(
			"returns a database-clock callback wait (processing=%s)",
			async (includeProcessingLease) => {
				const test = harness(adapter, [[{ retryAfterMs: 599_123 }]]);
				expect(await test.wait(includeProcessingLease)).toBe(599_123);
				expect(test.calls[0]?.params).toEqual(["attempt", includeProcessingLease, "event"]);
				expect(test.calls[0]?.sql).toContain('owner."leasedUntil" - clock_timestamp()');
				expect(test.calls[0]?.sql).toContain('event."processingLeasedUntil" - clock_timestamp()');
			},
		);
		it.each([undefined, -1, Number.NaN, "60000"])(
			"rejects an unavailable or invalid callback wait %s",
			async (retryAfterMs) => {
				const test = harness(adapter, [retryAfterMs === undefined ? [] : [{ retryAfterMs }]]);
				await expect(test.wait()).rejects.toThrow("INVALID_PROVIDER_EVENT_WAIT");
			},
		);
		it("reads the exact subject and database clock even when no owner exists", async () => {
			vi.spyOn(crypto, "randomUUID").mockReturnValue(uuid);
			const test = harness(adapter, [[{ now, phaseKey: null }]]);
			expect(await test.claim({ phase, workflowId: owner.workflowId })).toEqual({
				owned: true,
				phaseOwner: { workflowId: owner.workflowId, phaseKey: uuid, epoch: 1 },
			});
			expect(test.calls[0]?.sql).toContain('SELECT clock_timestamp() AS "now"');
			expect(test.calls[0]?.sql).toContain(
				'FROM (SELECT 1) anchor LEFT JOIN "media_workflow_phase_owner"',
			);
			expect(test.calls[0]?.params).toEqual(["verification", "asset-1", 7]);
			expect(test.calls[1]?.sql).toContain(
				'ON CONFLICT ("phaseKind", "subjectId", "generation") DO NOTHING',
			);
			expect(test.calls[1]?.params).toEqual([
				uuid,
				"verification",
				"asset-1",
				7,
				owner.workflowId,
				1,
				new Date(now.getTime() + 600_000),
			]);
		});

		it("does not continue without a database clock row", async () => {
			const test = harness(adapter, [[]]);
			await expect(test.claim({ phase, workflowId: owner.workflowId })).rejects.toThrow(
				"IMAGE_PHASE_CLOCK_UNAVAILABLE",
			);
			expect(test.calls).toHaveLength(1);
		});

		it("renews using all prior receipt and lease fields in the persisted CAS", async () => {
			const test = harness(adapter, [[{ ...lease, now }]]);
			expect(
				await test.claim({ phase, workflowId: owner.workflowId, expectedOwner: owner }),
			).toEqual({ owned: true, phaseOwner: owner });
			expect(test.calls[1]?.sql).toMatch(
				/WHERE "phaseKey" = \$\d+ AND "workflowId" = \$\d+ AND "epoch" = \$\d+ AND "leasedUntil" = \$\d+/,
			);
			expect(test.calls[1]?.params.slice(-4)).toEqual([
				owner.phaseKey,
				owner.workflowId,
				owner.epoch,
				lease.leasedUntil,
			]);
			expect(test.calls[1]?.params.slice(0, 3)).toEqual([
				owner.workflowId,
				owner.epoch,
				new Date(now.getTime() + 600_000),
			]);
		});

		it.each([0, 2])(
			"reports no ownership unless exactly one write wins (changed=%s)",
			async (changed) => {
				const test = harness(adapter, [[{ ...lease, now }]], [changed]);
				expect(
					await test.claim({ phase, workflowId: owner.workflowId, expectedOwner: owner }),
				).toEqual({ owned: false });
			},
		);

		it("does not issue a write for a live foreign owner", async () => {
			const test = harness(adapter, [[{ ...lease, now }]]);
			expect(await test.claim({ phase, workflowId: "workflow-other" })).toEqual({
				owned: false,
				phaseOwner: owner,
			});
			expect(test.calls).toHaveLength(1);
		});

		it("does not renew an expired expected owner from either adapter", async () => {
			const test = harness(adapter, [[{ ...lease, leasedUntil: now, now }]]);
			expect(
				await test.claim({ phase, workflowId: owner.workflowId, expectedOwner: owner }),
			).toEqual({ owned: false });
			expect(test.calls).toHaveLength(1);
		});

		it("binds generation ownership to the provider attempt, with generation zero", async () => {
			const test = harness(adapter, [[{ ...lease, now }]]);
			await test.claim({
				phase: { kind: "generation", attemptId: "attempt-1" },
				workflowId: owner.workflowId,
			});
			expect(test.calls[0]?.params).toEqual(["generation", "attempt-1", 0]);
		});

		it("reads only live owner identities for the matching phase", async () => {
			const test = harness(adapter, [[{ ...lease }], []]);
			expect(await test.get(phase)).toEqual(owner);
			expect(test.calls[0]?.params).toEqual(["verification", "asset-1", 7]);
			expect(test.calls[0]?.sql).toMatch(
				/"phaseKind" = \$\d+ AND "subjectId" = \$\d+ AND "generation" = \$\d+ AND "leasedUntil" > clock_timestamp\(\)/,
			);
			expect(await test.get(phase)).toBeUndefined();
		});

		it.each([true, false, undefined])(
			"requires an affirmative database current-owner check (%s)",
			async (current) => {
				const test = harness(adapter, [current === undefined ? [] : [{ current }]]);
				expect(await test.current(phase)).toBe(current === true);
				expect(test.calls[0]?.params).toEqual([
					"verification",
					"asset-1",
					7,
					owner.phaseKey,
					owner.workflowId,
					owner.epoch,
				]);
				expect(test.calls[0]?.sql).toMatch(
					/"phaseKind" = \$\d+ AND "subjectId" = \$\d+ AND "generation" = \$\d+ AND "phaseKey" = \$\d+ AND "workflowId" = \$\d+ AND "epoch" = \$\d+ AND "leasedUntil" > clock_timestamp\(\)/,
				);
			},
		);

		it.each([0, -1, 1.5, 1001, Number.NaN, Number.POSITIVE_INFINITY])(
			"rejects invalid cleanup limit %s before SQL",
			async (limit) => {
				const test = harness(adapter, []);
				await expect(test.cleanup(limit)).rejects.toThrow("INVALID_IMAGE_PHASE_CLEANUP_LIMIT");
				expect(test.calls).toHaveLength(0);
			},
		);

		it.each([1, 1000])(
			"cleans only old rows outside matching business leases (limit=%s)",
			async (limit) => {
				const test = harness(adapter, [[{ phaseKey: uuid }, { phaseKey: owner.phaseKey }]]);
				expect(await test.cleanup(limit)).toBe(2);
				const query = test.calls[0]!;
				expect(query.params).toEqual([limit]);
				expect(query.sql).toContain(
					"owner.\"leasedUntil\" < clock_timestamp() - INTERVAL '24 hours'",
				);
				expect(query.sql).toContain(
					'AND NOT EXISTS (SELECT 1 FROM "media_asset" asset WHERE owner."phaseKind" = \'verification\' AND asset."id" = owner."subjectId" AND asset."verificationGeneration" = owner."generation" AND asset."verificationLeasedUntil" > clock_timestamp())',
				);
				expect(query.sql).toContain(
					'AND NOT EXISTS (SELECT 1 FROM "generation_attempt" attempt WHERE owner."phaseKind" = \'generation\' AND attempt."id" = owner."subjectId" AND attempt."reconcileLeasedUntil" > clock_timestamp())',
				);
				expect(query.sql).toContain(
					'ORDER BY owner."leasedUntil", owner."phaseKey" FOR UPDATE OF owner SKIP LOCKED LIMIT $1',
				);
				expect(query.sql).toContain(
					'WHERE owner."phaseKey" = expired."phaseKey" RETURNING owner."phaseKey"',
				);
			},
		);
	},
);

it("keeps Prisma and Drizzle read, current-owner, callback wait and cleanup SQL equivalent", async () => {
	const adapters = [
		harness("Prisma", [[], [{ current: false }], [], [{ retryAfterMs: 0 }]]),
		harness("Drizzle", [[], [{ current: false }], [], [{ retryAfterMs: 0 }]]),
	];
	for (const test of adapters) {
		await test.get(phase);
		await test.current(phase);
		await test.cleanup(10);
		await test.wait();
	}
	expect(adapters[0]!.calls).toEqual(adapters[1]!.calls);
});
