import { describe, it, expect, vi, beforeEach } from "vitest";
const helpers = vi.hoisted(() => ({ fulfill: vi.fn(), revoke: vi.fn(), lookup: vi.fn() }));
vi.mock("@repo/database", () => ({
	fulfillImagePassPurchaseInTransaction: helpers.fulfill,
	revokeImagePassPurchaseInTransaction: helpers.revoke,
	getImagePassPurchaseByProviderPayment: helpers.lookup,
	PAYMENT_PROVIDER_CORRELATION_MISSING: "PAYMENT_PROVIDER_CORRELATION_MISSING",
}));
import { applyImagePassPaymentFact, tryApplyImagePassAdjustment } from "./image-pass-reducer";
import { normalizeProviderPaymentEvent } from "./lifecycle-normalization";
const paid = {
	provider: "paypal" as const,
	providerEventId: "WH-1",
	checkoutIntentId: "intent-1",
	providerOrderId: "ORDER-1",
	providerPaymentId: "CAP-1",
	providerCustomerId: null,
	amountMicros: 1000000n,
	currency: "USD",
	occurredAt: new Date("2026-10-19T12:00:00Z"),
};
const refund = {
	provider: "paypal" as const,
	providerEventId: "WH-R1",
	providerPaymentId: "CAP-1",
	providerRefundId: "REFUND-1",
	amountMicros: 500000n,
	currency: "USD",
	occurredAt: paid.occurredAt,
};
function transaction(candidates: unknown[] = []) {
	return {
		$queryRaw: vi
			.fn()
			.mockImplementation(async (strings: TemplateStringsArray) =>
				strings.join("").includes('FROM "payment_event"') ? candidates : [],
			),
		paymentEvent: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
		outboxEvent: { upsert: vi.fn() },
	};
}
describe("verified image-pass reducers", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		helpers.fulfill.mockResolvedValue({ created: true, grantId: "grant-1" });
		helpers.lookup.mockResolvedValue({ id: "grant-1" });
		helpers.revoke.mockResolvedValue({ replayed: false });
	});
	it("grants only via the dedicated entitlement helper", async () => {
		const tx = transaction();
		await expect(
			applyImagePassPaymentFact(paid, tx as never, { paymentEventId: "event-1" }),
		).resolves.toEqual({ grantsCreated: 1 });
		expect(helpers.fulfill).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "paypal",
				providerPaymentId: "CAP-1",
				amountMicros: 1000000n,
				paymentEventId: "event-1",
			}),
			tx,
		);
	});
	it("capture and webhook replays do not create a second grant", async () => {
		helpers.fulfill.mockResolvedValue({ created: false, grantId: "grant-1" });
		await expect(applyImagePassPaymentFact(paid, transaction() as never)).resolves.toEqual({
			grantsCreated: 0,
		});
	});
	it.each([
		{ amountMicros: 1n },
		{ amountMicros: 1000001n },
		{ currency: "EUR" },
		{ provider: "waffo" },
	])("rejects a verified but incorrect offer payment %s", async (patch) => {
		await expect(
			applyImagePassPaymentFact({ ...paid, ...patch } as never, transaction() as never),
		).rejects.toThrow("IMAGE_PASS_PAYMENT_AMOUNT_INVALID");
		expect(helpers.fulfill).not.toHaveBeenCalled();
	});
	it("partial refunds revoke through the pass ledger, without normal-credit debt", async () => {
		const tx = transaction();
		await expect(tryApplyImagePassAdjustment(refund, tx as never)).resolves.toEqual({
			grantsCreated: 0,
		});
		expect(helpers.revoke).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "REFUND", amountMicros: 500000n }),
			tx,
		);
	});
	it("disputes and reversals freeze the same purchase", async () => {
		await tryApplyImagePassAdjustment(
			{ ...refund, adjustmentKind: "REVERSAL" },
			transaction() as never,
		);
		expect(helpers.revoke).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "DISPUTE" }),
			expect.anything(),
		);
	});
	it("does not route other products to image passes", async () => {
		helpers.lookup.mockResolvedValue(null);
		await expect(tryApplyImagePassAdjustment(refund, transaction() as never)).resolves.toBeNull();
		expect(helpers.revoke).not.toHaveBeenCalled();
	});
	it("requeues an earlier verified dispute after the matching payment commits", async () => {
		const envelope = {
			id: "WH-D",
			event_type: "CUSTOMER.DISPUTE.CREATED",
			resource: {
				dispute_id: "D-1",
				create_time: "2026-10-19T12:01:00Z",
				disputed_transactions: [{ seller_transaction_id: "CAP-1" }],
				dispute_amount: { value: "1.00", currency_code: "USD" },
			},
		};
		const tx = transaction([
			{ id: "early", envelope },
			{
				id: "another",
				envelope: {
					...envelope,
					resource: {
						...envelope.resource,
						disputed_transactions: [{ seller_transaction_id: "CAP-2" }],
					},
				},
			},
		]);
		await applyImagePassPaymentFact(paid, tx as never);
		expect(tx.outboxEvent.upsert).toHaveBeenCalledTimes(1);
		expect(tx.outboxEvent.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { dedupeKey: "image-pass-adjustment-correlation-replay:early" },
			}),
		);
	});
	it("normalizes seller capture binding from a verified PayPal dispute", () => {
		const value = {
			id: "WH-D",
			event_type: "CUSTOMER.DISPUTE.CREATED",
			create_time: "2026-10-19T12:01:00Z",
			resource: {
				dispute_id: "D-1",
				disputed_transactions: [
					{ buyer_transaction_id: "BUYER-OTHER", seller_transaction_id: "CAP-1" },
				],
				dispute_amount: { value: "0.50", currency_code: "USD" },
			},
		};
		expect(normalizeProviderPaymentEvent("paypal", value)).toMatchObject({
			kind: "PAYMENT_DISPUTED",
			fact: { providerPaymentId: "CAP-1", providerRefundId: "dispute:D-1", amountMicros: 500000n },
		});
		expect(() =>
			normalizeProviderPaymentEvent("paypal", {
				...value,
				resource: { ...value.resource, disputed_transactions: [] },
			}),
		).toThrow("PAYPAL_DISPUTE_BINDING_INVALID");
	});
});
