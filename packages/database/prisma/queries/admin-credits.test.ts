import { describe, expect, it, vi } from "vitest";

import { adjustAdminCredits, planAdminCreditDeduction } from "./admin-credits";

describe("independent administrator credit adjustment", () => {
	it("plans an exact FIFO debit across lots without making a lot negative", () => {
		expect(
			planAdminCreditDeduction(50n, [
				{ id: "first", remainingAmount: 30n },
				{ id: "second", remainingAmount: 40n },
			]),
		).toEqual([
			{ id: "first", amount: 30n },
			{ id: "second", amount: 20n },
		]);
		expect(() =>
			planAdminCreditDeduction(71n, [
				{ id: "first", remainingAmount: 30n },
				{ id: "second", remainingAmount: 40n },
			]),
		).toThrow("ADMIN_CREDITS_INSUFFICIENT_BALANCE");
	});
	it("rejects a service account attempting to widen the target owner before any query", async () => {
		const transaction = vi.fn();
		await expect(
			adjustAdminCredits(
				{
					scope: { kind: "organization", organizationId: "org-1" },
					ownerType: "USER",
					ownerId: "victim",
					actorId: "service-1",
					idempotencyKey: "credit-adjust-1",
					credits: 100,
					action: "grant",
					reason: "Support adjustment",
				},
				{ $transaction: transaction } as never,
			),
		).rejects.toThrow("ADMIN_SCOPE_FORBIDDEN");
		expect(transaction).not.toHaveBeenCalled();
	});
	it("rejects non-integer or unbounded input without a database transaction", async () => {
		for (const credits of [0, -1, 0.5, 1_000_000_001, Number.POSITIVE_INFINITY]) {
			const transaction = vi.fn();
			await expect(
				adjustAdminCredits(
					{
						scope: { kind: "platform" },
						ownerType: "USER",
						ownerId: "user-1",
						actorId: "admin-1",
						idempotencyKey: "credit-adjust-1",
						credits,
						action: "deduct",
						reason: "Support adjustment",
					},
					{ $transaction: transaction } as never,
				),
			).rejects.toThrow("ADMIN_CREDITS_INPUT_INVALID");
			expect(transaction).not.toHaveBeenCalled();
		}
	});
});
