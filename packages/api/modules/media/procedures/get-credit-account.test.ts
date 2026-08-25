import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
	findAccount: vi.fn(),
	aggregateLots: vi.fn(),
	findSubscription: vi.fn(),
	countActiveJobs: vi.fn(),
}));
const freeCredits = vi.hoisted(() => ({ ensure: vi.fn() }));

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database/client", () => ({
	db: {
		creditAccount: { findUnique: database.findAccount },
		creditLot: { aggregate: database.aggregateLots },
		subscription: { findFirst: database.findSubscription },
		generationJob: { count: database.countActiveJobs },
	},
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
		freeCredits.ensure.mockResolvedValue({ status: "GRANTED" });
	});

	it("returns current balance and plan concurrency without exposing billing internals", async () => {
		await expect(
			call(getCreditAccount, undefined, { context: { headers: new Headers() } }),
		).resolves.toEqual({
			spendableCredits: "6",
			reservedCredits: "4",
			creditDebt: "0",
			version: 7,
			activeJobs: 2,
			maximumConcurrentJobs: 3,
			maximumInputBytes: 20 * 1024 * 1024,
		});
		expect(freeCredits.ensure).toHaveBeenCalledWith("user-1");
	});
});
