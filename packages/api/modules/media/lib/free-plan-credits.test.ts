import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
	ensureFreeMonthlyCreditGrant: vi.fn(),
}));
const databaseClient = vi.hoisted(() => ({ db: { kind: "database-client" } }));

vi.mock("@repo/database", () => ({
	ensureFreeMonthlyCreditGrant: database.ensureFreeMonthlyCreditGrant,
}));
vi.mock("@repo/database/client", () => databaseClient);

import { ensureFreePlanCreditsForUser } from "./free-plan-credits";

describe("Free monthly credits", () => {
	beforeEach(() => {
		vi.clearAllMocks();
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
});
