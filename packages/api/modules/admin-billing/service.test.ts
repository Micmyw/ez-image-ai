import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	adjust: vi.fn(),
	list: vi.fn(),
	refund: vi.fn(),
	reconcile: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	adjustAdminCredits: mocks.adjust,
	listAdminRefundablePayments: mocks.list,
}));
vi.mock("@repo/payments", () => ({
	refundAdminOrder: mocks.refund,
	reconcileAdminRefund: mocks.reconcile,
}));
import { executeAdminBillingOperation } from "./service";

const context = {
	scope: { kind: "user", userId: "owner-1" } as const,
	actorId: "service-1",
	executionId: "execution-1",
};
beforeEach(() => vi.clearAllMocks());
describe("administrator billing operation contracts", () => {
	it("never accepts a caller's money amount, ownership scope or credit override on refund", async () => {
		for (const extra of [
			{ amountMicros: "1" },
			{ currency: "CNY" },
			{ deductCredits: 0 },
			{ scope: { kind: "platform" } },
		]) {
			await expect(
				executeAdminBillingOperation("orders_refund", { orderNo: "pack:1", ...extra }, context),
			).rejects.toThrow();
		}
		expect(mocks.refund).not.toHaveBeenCalled();
	});
	it("uses authenticated scope and stable execution ID for independent credits", async () => {
		await executeAdminBillingOperation(
			"credits_adjust",
			{
				ownerType: "USER",
				ownerId: "owner-1",
				action: "grant",
				credits: 40,
				reason: "Support",
			},
			context,
		);
		expect(mocks.adjust).toHaveBeenCalledWith(
			expect.objectContaining({
				scope: context.scope,
				actorId: "service-1",
				idempotencyKey: "execution-1",
			}),
		);
	});
	it("routes reconciliation to the query-only recovery operation with the same scope", async () => {
		await executeAdminBillingOperation("orders_reconcile", { requestId: "refund-1" }, context);
		expect(mocks.reconcile).toHaveBeenCalledWith({
			requestId: "refund-1",
			scope: context.scope,
			actorId: "service-1",
		});
		expect(mocks.refund).not.toHaveBeenCalled();
	});
});
