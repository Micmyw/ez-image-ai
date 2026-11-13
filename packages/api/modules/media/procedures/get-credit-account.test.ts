import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
	findAccount: vi.fn(),
	aggregateLots: vi.fn(),
	findSubscription: vi.fn(),
	countActiveJobs: vi.fn(),
	adminTestSkuKeys: vi.fn(),
}));
const freeCredits = vi.hoisted(() => ({ ensure: vi.fn() }));

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database/media-image-admin-test-access", () => ({
	loadImageAdminTestSkuKeys: database.adminTestSkuKeys,
}));
vi.mock("@repo/database/client", () => ({
	db: {
		creditAccount: { findUnique: database.findAccount },
		creditLot: { aggregate: database.aggregateLots },
		generationJob: { count: database.countActiveJobs },
	},
}));
vi.mock("@repo/database", () => ({
	ACTIVE_GENERATION_JOB_STATUSES: [
		"RESERVED",
		"DISPATCH_QUEUED",
		"SUBMITTING",
		"PROVIDER_PENDING",
		"PROVIDER_RUNNING",
		"NEEDS_RECONCILIATION",
		"FINALIZING",
	],
	findEffectivePaidSubscription: database.findSubscription,
}));
vi.mock("../lib/free-plan-credits", () => ({
	ensureFreePlanCreditsForUser: freeCredits.ensure,
}));

import { auth } from "@repo/auth";

import { getCreditAccount } from "./get-credit-account";

describe("getCreditAccount", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "user-1" },
			session: { id: "session-1" },
		} as never);
		database.findAccount.mockResolvedValue({ reservedCredits: 4n, creditDebt: 0n, version: 7 });
		database.aggregateLots.mockResolvedValue({ _sum: { remainingAmount: 6n } });
		database.findSubscription.mockResolvedValue({
			plan: { metadata: { planId: "creator" }, name: "ignored" },
		});
		database.countActiveJobs.mockResolvedValue(2);
		database.adminTestSkuKeys.mockResolvedValue(["gpt-image-2-6-sunburst-1k"]);
		freeCredits.ensure.mockResolvedValue({ status: "GRANTED" });
	});

	it("returns balance and input entitlement without an unfinished-job quota", async () => {
		await expect(
			call(getCreditAccount, undefined, { context: { headers: new Headers() } }),
		).resolves.toEqual({
			adminTestSkuKeys: [],
			spendableCredits: "6",
			reservedCredits: "4",
			creditDebt: "0",
			version: 7,
			activeJobs: 2,
			maximumInputBytes: 20 * 1024 * 1024,
		});
		expect(freeCredits.ensure).toHaveBeenCalledWith("user-1");
		expect(database.adminTestSkuKeys).not.toHaveBeenCalled();
	});
	it("returns only the current administrator's server-owned image test selections", async () => {
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "admin-1", role: "admin" },
			session: { id: "admin-session" },
		} as never);
		await expect(
			call(getCreditAccount, undefined, { context: { headers: new Headers() } }),
		).resolves.toMatchObject({
			adminTestSkuKeys: ["gpt-image-2-6-sunburst-1k"],
			spendableCredits: "6",
		});
		expect(database.adminTestSkuKeys).toHaveBeenCalledWith("admin-1", expect.anything());
	});
});
