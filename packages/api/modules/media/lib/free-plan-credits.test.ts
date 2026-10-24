import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
	ensureFreeMonthlyCreditGrant: vi.fn(),
	ensureOneTimeLoginCreditGrant: vi.fn(),
	hasMatchingFreeMonthlyCreditGrant: vi.fn(),
}));
const databaseClient = vi.hoisted(() => ({ db: { kind: "database-client" } }));
const logs = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock("@repo/database", () => database);
vi.mock("@repo/database/client", () => databaseClient);
vi.mock("@repo/logs", () => ({ logger: logs }));

import {
	ensureFreePlanCreditsForGeneration,
	ensureFreePlanCreditsForUser,
} from "./free-plan-credits";

describe("one lifetime Free sign-in allowance", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		database.ensureOneTimeLoginCreditGrant.mockResolvedValue({ status: "GRANTED" });
	});

	it.each([
		["balance", ensureFreePlanCreditsForUser],
		["generation", ensureFreePlanCreditsForGeneration],
	] as const)(
		"uses only the lifetime grant for %s reads across month boundaries",
		async (_name, ensure) => {
			await ensure("user-1", new Date("2026-10-24T00:00:00Z"));
			database.ensureOneTimeLoginCreditGrant.mockResolvedValue({ status: "ALREADY_GRANTED" });
			await ensure("user-1", new Date("2026-11-01T00:00:00Z"));
			expect(database.ensureOneTimeLoginCreditGrant).toHaveBeenCalledTimes(2);
			expect(database.ensureOneTimeLoginCreditGrant).toHaveBeenCalledWith(
				{ ownerId: "user-1" },
				databaseClient.db,
			);
			expect(database.ensureFreeMonthlyCreditGrant).not.toHaveBeenCalled();
			expect(database.hasMatchingFreeMonthlyCreditGrant).not.toHaveBeenCalled();
		},
	);

	it.each(["ANONYMOUS_USER", "USER_NOT_FOUND"])(
		"does not fall back to monthly credits for %s",
		async (status) => {
			database.ensureOneTimeLoginCreditGrant.mockResolvedValue({ status });
			await expect(ensureFreePlanCreditsForUser("guest-1")).resolves.toBeUndefined();
			expect(database.ensureFreeMonthlyCreditGrant).not.toHaveBeenCalled();
		},
	);

	it.each([
		["balance", ensureFreePlanCreditsForUser],
		["generation", ensureFreePlanCreditsForGeneration],
	] as const)(
		"keeps funded %s requests available when the lifetime grant must retry",
		async (_name, ensure) => {
			database.ensureOneTimeLoginCreditGrant.mockRejectedValueOnce(
				new Error("private connection failure must not be logged"),
			);
			await ensure("user-1");
			expect(database.ensureFreeMonthlyCreditGrant).not.toHaveBeenCalled();
			expect(logs.warn).toHaveBeenCalledWith("Login credit bonus could not be granted", {
				ctx: "loginCreditBonus",
				userId: "user-1",
				errorType: "Error",
			});
			expect(JSON.stringify(logs.warn.mock.calls)).not.toContain("private connection failure");
		},
	);
});
