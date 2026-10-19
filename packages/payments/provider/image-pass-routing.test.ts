import { describe, it, expect, vi, beforeEach } from "vitest";
const reducers = vi.hoisted(() => ({
	pack: vi.fn(),
	packRefund: vi.fn(),
	subscription: vi.fn(),
	refund: vi.fn(),
	pass: vi.fn(),
	passRefund: vi.fn(),
	lock: vi.fn(),
	requeue: vi.fn(),
	lookup: vi.fn(),
	fail: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	claimPaymentEvent: vi.fn(),
	failPaymentEvent: reducers.fail,
	getImagePassPurchaseByProviderPayment: reducers.lookup,
	PAYMENT_PROVIDER_CORRELATION_MISSING: "PAYMENT_PROVIDER_CORRELATION_MISSING",
	runSerializable: async (client: unknown, operation: (tx: unknown) => unknown) =>
		operation(client),
}));
vi.mock("@repo/logs", () => ({ logger: { error: vi.fn() } }));
vi.mock("./credit-pack-reducer", () => ({
	applyCreditPackPaymentFact: reducers.pack,
	applyCreditPackRefundFact: reducers.packRefund,
}));
vi.mock("./lifecycle-reducer", () => ({ applyProviderBillingFact: reducers.subscription }));
vi.mock("./refund-reducer", () => ({ applyProviderRefundFact: reducers.refund }));
vi.mock("./image-pass-reducer", () => ({
	applyImagePassPaymentFact: reducers.pass,
	tryApplyImagePassAdjustment: reducers.passRefund,
	lockImagePassPayment: reducers.lock,
	requeueImagePassAdjustments: reducers.requeue,
}));
import { applyVerifiedProviderFact, processClaimedProviderPaymentEvent } from "./processor";
const fact = {
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
const options = { paymentEventId: "event-1", now: fact.occurredAt };
describe("verified payment product routing", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		for (const reducer of [
			reducers.pack,
			reducers.packRefund,
			reducers.subscription,
			reducers.refund,
			reducers.pass,
		])
			reducer.mockResolvedValue({ grantsCreated: 0 });
		reducers.passRefund.mockResolvedValue(null);
	});
	it("routes only a bound IMAGE_PASS intent to the pass grant helper", async () => {
		const tx = {
			paymentCheckoutIntent: {
				findUnique: vi.fn().mockResolvedValue({ productKind: "IMAGE_PASS" }),
			},
		};
		await applyVerifiedProviderFact({ kind: "CREDIT_PACK_PAID", fact }, tx as never, options);
		expect(reducers.pass).toHaveBeenCalled();
		expect(reducers.pack).not.toHaveBeenCalled();
	});
	it("preserves the existing credit-pack fulfillment", async () => {
		const tx = {
			paymentCheckoutIntent: {
				findUnique: vi.fn().mockResolvedValue({ productKind: "CREDIT_PACK" }),
			},
		};
		await applyVerifiedProviderFact({ kind: "CREDIT_PACK_PAID", fact }, tx as never, options);
		expect(reducers.pack).toHaveBeenCalled();
		expect(reducers.pass).not.toHaveBeenCalled();
	});
	it("refunds a pass without invoking ordinary-credit reducers", async () => {
		reducers.passRefund.mockResolvedValue({ grantsCreated: 0 });
		await applyVerifiedProviderFact(
			{ kind: "PAYMENT_REFUNDED", fact: { ...fact, providerRefundId: "refund-1" } },
			{} as never,
			options,
		);
		expect(reducers.refund).not.toHaveBeenCalled();
		expect(reducers.packRefund).not.toHaveBeenCalled();
	});
	it("keeps other purchase refunds on their existing path", async () => {
		await applyVerifiedProviderFact(
			{ kind: "PAYMENT_REFUNDED", fact: { ...fact, providerRefundId: "refund-1" } },
			{} as never,
			options,
		);
		expect(reducers.refund).toHaveBeenCalled();
	});
	it("retains an early dispute for durable correlation retry", async () => {
		await expect(
			applyVerifiedProviderFact(
				{ kind: "PAYMENT_DISPUTED", fact: { ...fact, providerRefundId: "dispute:D-1" } },
				{} as never,
				options,
			),
		).rejects.toThrow("PAYMENT_PROVIDER_CORRELATION_MISSING");
		expect(reducers.refund).not.toHaveBeenCalled();
	});
	it("rechecks correlation after persisting failure to close the grant/failure race", async () => {
		const now = new Date();
		const event = {
			provider: "paypal",
			providerEnvironment: "sandbox",
			status: "PROCESSING",
			processingToken: "lease-1",
			processingLeasedUntil: new Date(now.getTime() + 60000),
			attemptCount: 0,
			envelope: {
				id: "WH-D",
				event_type: "CUSTOMER.DISPUTE.CREATED",
				create_time: now.toISOString(),
				resource: {
					dispute_id: "D-1",
					disputed_transactions: [{ seller_transaction_id: "CAP-1" }],
					dispute_amount: { value: "1.00", currency_code: "USD" },
				},
			},
		};
		const tx = {
			paymentEvent: { findUnique: vi.fn().mockResolvedValue(event) },
			$queryRaw: vi.fn().mockResolvedValue([{ id: "event-1", ...event }]),
		};
		reducers.fail.mockImplementation(async () => {
			reducers.lookup.mockResolvedValue({ id: "just-committed-grant" });
			return true;
		});
		await expect(
			processClaimedProviderPaymentEvent(
				{ paymentEventId: "event-1", processingToken: "lease-1", now },
				tx as never,
			),
		).rejects.toThrow("PAYMENT_PROVIDER_CORRELATION_MISSING");
		expect(reducers.fail).toHaveBeenCalledWith(
			"event-1",
			"lease-1",
			expect.objectContaining({ reason: "PAYMENT_PROVIDER_CORRELATION_MISSING" }),
			tx,
		);
		expect(reducers.requeue).toHaveBeenCalledWith("CAP-1", tx);
		expect(reducers.fail.mock.invocationCallOrder[0]).toBeLessThan(
			reducers.requeue.mock.invocationCallOrder[0]!,
		);
	});
});
