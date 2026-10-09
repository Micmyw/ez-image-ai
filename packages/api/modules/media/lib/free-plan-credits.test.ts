import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
	ensureFreeMonthlyCreditGrant: vi.fn(),
	hasMatchingFreeMonthlyCreditGrant: vi.fn(),
}));
const databaseClient = vi.hoisted(() => ({ db: { kind: "database-client" } }));

vi.mock("@repo/database", () => ({
	ensureFreeMonthlyCreditGrant: database.ensureFreeMonthlyCreditGrant,
	hasMatchingFreeMonthlyCreditGrant: database.hasMatchingFreeMonthlyCreditGrant,
}));
vi.mock("@repo/database/client", () => databaseClient);

import {
	ensureFreePlanCreditsForGeneration,
	ensureFreePlanCreditsForUser,
} from "./free-plan-credits";

describe("Free monthly credits", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		database.hasMatchingFreeMonthlyCreditGrant.mockResolvedValue(false);
		database.ensureFreeMonthlyCreditGrant.mockResolvedValue({
			status: "GRANTED",
			referenceKey: "free-plan:user:user-1:2026-08",
			accountId: "account-1",
		});
	});

	it("delegates the canonical Free allowance to the transactional ledger entry", async () => {
		const now = new Date("2026-08-25T06:00:00.000Z");

		await ensureFreePlanCreditsForUser("user-1", now);

		expect(database.ensureFreeMonthlyCreditGrant).toHaveBeenCalledWith(
			{ ownerId: "user-1", amount: 25n, now },
			databaseClient.db,
		);
	});

	it("delegates identity classification to the authoritative transactional helper", async () => {
		await ensureFreePlanCreditsForUser("guest-1");

		expect(database.ensureFreeMonthlyCreditGrant).toHaveBeenCalledWith(
			expect.objectContaining({ ownerId: "guest-1" }),
			databaseClient.db,
		);
	});

	it("skips the grant transaction only for a confirmed generation preflight replay", async () => {
		const now = new Date("2026-08-25T06:00:00.000Z");
		database.hasMatchingFreeMonthlyCreditGrant.mockResolvedValue(true);
		await ensureFreePlanCreditsForGeneration("user-1", now);
		expect(database.hasMatchingFreeMonthlyCreditGrant).toHaveBeenCalledWith(
			{ ownerId: "user-1", amount: 25n, now },
			databaseClient.db,
		);
		expect(database.ensureFreeMonthlyCreditGrant).not.toHaveBeenCalled();
	});

	it("uses the original transaction for a missing or uncertain grant", async () => {
		const now = new Date("2026-09-01T00:00:00.000Z");
		await ensureFreePlanCreditsForGeneration("user-1", now);
		expect(database.ensureFreeMonthlyCreditGrant).toHaveBeenCalledWith(
			{ ownerId: "user-1", amount: 25n, now },
			databaseClient.db,
		);
	});

	it.each(["PAID_SUBSCRIPTION", "ANONYMOUS_USER", "USER_NOT_FOUND"])(
		"keeps the public helper's %s contract even if a previous grant exists",
		async (status) => {
			database.hasMatchingFreeMonthlyCreditGrant.mockResolvedValue(true);
			database.ensureFreeMonthlyCreditGrant.mockResolvedValue({ status });
			await expect(ensureFreePlanCreditsForUser("user-1")).resolves.toEqual({ status });
			expect(database.hasMatchingFreeMonthlyCreditGrant).not.toHaveBeenCalled();
		},
	);
});
