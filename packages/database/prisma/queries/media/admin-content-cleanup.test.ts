import { describe, expect, it, vi } from "vitest";

import { executeAdminContentCleanup, previewAdminContentCleanup } from "./admin-content-cleanup";

describe("administrator cleanup plan validity", () => {
	it("expires a saved plan using database time before any deletion or ledger access", async () => {
		let now = new Date("2026-11-14T00:00:00.000Z");
		const audits = new Map<string, unknown>();
		const tx = {
			$queryRaw: vi.fn(async () => [{ now }]),
			$executeRaw: vi.fn(async () => 1),
			auditLog: {
				create: vi.fn(async ({ data }) => {
					audits.set(data.id, data);
					return data;
				}),
				findUnique: vi.fn(async ({ where }) => audits.get(where.id) ?? null),
			},
		};
		const client = { $transaction: vi.fn(async (work) => work(tx)) };
		const plan = await previewAdminContentCleanup(
			{ assetIds: [], includeExpiredInternalDiagnostics: false, reason: "Preview test plan" },
			"admin",
			client as never,
		);
		now = new Date("2026-11-14T00:11:00.000Z");
		await expect(
			executeAdminContentCleanup(
				{ planId: plan.planId, planHash: plan.planHash, confirmation: plan.confirmation },
				"admin",
				client as never,
			),
		).rejects.toThrow("ADMIN_CLEANUP_PLAN_EXPIRED");
		expect(audits.size).toBe(1);
	});
});
