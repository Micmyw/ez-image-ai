import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database", () => ({
	previewAdminContentCleanup: vi.fn(),
	executeAdminContentCleanup: vi.fn(),
	listRecentAdminContentCleanupPlans: vi.fn(),
}));
vi.mock("@repo/database/client", () => ({ db: {} }));
import { auth } from "@repo/auth";
import {
	executeAdminContentCleanup,
	listRecentAdminContentCleanupPlans,
	previewAdminContentCleanup,
} from "@repo/database";

import {
	adminContentCleanupExecute,
	adminContentCleanupPreview,
	adminContentCleanupRecent,
} from "./admin-content-cleanup";
const context = { context: { headers: new Headers(), responseHeaders: new Headers() } };
const input = {
	assetIds: ["asset"],
	includeExpiredInternalDiagnostics: false,
	reason: "Remove selected content",
};
const plan = {
	planId: "plan",
	planHash: "a".repeat(64),
	confirmation: "DELETE 1 ASSETS AND 0 INTERNAL LOGS",
	expiresAt: new Date(Date.now() + 60_000),
	assets: [{ id: "asset", bytes: "10", blocked: [] }],
	assetCount: 1,
	assetBytes: "10",
	logCount: 0,
	logBytes: 0,
};
const confirmation = {
	planId: plan.planId,
	planHash: plan.planHash,
	confirmation: plan.confirmation,
};
function login(role: string | null) {
	vi.mocked(auth.api.getSession).mockResolvedValue(
		role ? ({ user: { id: "admin", role }, session: { id: "session" } } as never) : null,
	);
}
beforeEach(() => {
	vi.clearAllMocks();
	login("admin");
});
describe("administrator cleanup API boundary", () => {
	it.each([null, "user"])("blocks %s before planning or execution", async (role) => {
		login(role);
		await expect(call(adminContentCleanupPreview, input, context)).rejects.toMatchObject({
			code: role ? "FORBIDDEN" : "UNAUTHORIZED",
		});
		await expect(call(adminContentCleanupExecute, confirmation, context)).rejects.toMatchObject({
			code: role ? "FORBIDDEN" : "UNAUTHORIZED",
		});
		await expect(call(adminContentCleanupRecent, {}, context)).rejects.toMatchObject({
			code: role ? "FORBIDDEN" : "UNAUTHORIZED",
		});
		expect(previewAdminContentCleanup).not.toHaveBeenCalled();
		expect(executeAdminContentCleanup).not.toHaveBeenCalled();
	});
	it("returns a private bounded preview without running deletion", async () => {
		vi.mocked(previewAdminContentCleanup).mockResolvedValue(plan);
		expect(await call(adminContentCleanupPreview, input, context)).toEqual(plan);
		expect(previewAdminContentCleanup).toHaveBeenCalledWith(input, "admin", expect.anything());
		expect(executeAdminContentCleanup).not.toHaveBeenCalled();
		expect(context.context.responseHeaders.get("Cache-Control")).toBe("private, no-store");
	});
	it("restores only the current administrator's plans with private cache headers", async () => {
		vi.mocked(listRecentAdminContentCleanupPlans).mockResolvedValue([plan]);
		expect(await call(adminContentCleanupRecent, {}, context)).toEqual([plan]);
		expect(listRecentAdminContentCleanupPlans).toHaveBeenCalledWith("admin", expect.anything());
		expect(context.context.responseHeaders.get("Cache-Control")).toBe("private, no-store");
	});
	it("executes only the exact plan ID/hash/confirmation for the current administrator", async () => {
		vi.mocked(executeAdminContentCleanup).mockResolvedValue({
			planId: "plan",
			queuedAssets: 1,
			deletedLogs: 0,
			requeuedAssets: 0,
			replayed: false,
		});
		expect(await call(adminContentCleanupExecute, confirmation, context)).toMatchObject({
			queuedAssets: 1,
		});
		expect(executeAdminContentCleanup).toHaveBeenCalledWith(
			confirmation,
			"admin",
			expect.anything(),
		);
	});
	it("rejects arbitrary keys, extra tables and oversized batches", async () => {
		for (const changed of [
			{ ...input, objectKey: "private/other" },
			{ ...input, table: "credit_ledger_entry" },
			{ ...input, assetIds: Array.from({ length: 21 }, (_, i) => `asset-${i}`) },
		])
			await expect(
				call(adminContentCleanupPreview, changed as never, context),
			).rejects.toBeDefined();
		expect(previewAdminContentCleanup).not.toHaveBeenCalled();
	});
	it.each([
		"ADMIN_CLEANUP_PLAN_STALE",
		"ADMIN_CLEANUP_PLAN_EXPIRED",
		"ADMIN_CLEANUP_CONFIRMATION_REQUIRED",
	])("returns a bounded conflict for %s", async (code) => {
		vi.mocked(executeAdminContentCleanup).mockRejectedValue(new Error(code));
		await expect(call(adminContentCleanupExecute, confirmation, context)).rejects.toMatchObject({
			code: "CONFLICT",
			message: code,
		});
	});
});
