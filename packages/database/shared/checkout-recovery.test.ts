import { describe, expect, it, vi } from "vitest";

import {
	claimCheckoutActivationWithStore,
	claimCheckoutRecoveryWithStore,
	finishCheckoutRecoveryWithStore,
	requestCheckoutRecoveryWithStore,
	readCheckoutRecovery,
	hasCheckoutFinancialReceipt,
	type RecoverableCheckout,
	type CheckoutRecoveryPersistence,
	type CheckoutRecoveryTransaction,
} from "./checkout-recovery";

function fixture(mode: "MERCHANT" | "LEGACY" = "MERCHANT") {
	let intent: RecoverableCheckout = {
		id: "i1",
		provider: "paypal",
		ownerType: "USER",
		ownerId: "u1",
		submittedByUserId: "u1",
		productKind: "PLAN",
		status: "PROVIDER_PENDING",
		planKey: "creator",
		interval: "month",
		providerSessionId: "I-1",
		providerOrderId: null,
		providerCheckoutUrl: "https://paypal.test/approve",
		expiresAt: null,
		billingPlan: { providerPriceId: "P-1" },
		checkoutRecovery: { version: 1, mode, sequence: 0, status: "PENDING", failures: 0 },
	};
	const enqueue = vi.fn();
	const tx: CheckoutRecoveryTransaction = {
		lock: vi.fn(),
		find: async () => structuredClone(intent),
		hasFinancialActivity: vi.fn().mockResolvedValue(false),
		update: async (_id, patch) => {
			intent = { ...intent, ...patch };
			return structuredClone(intent);
		},
		enqueue,
		audit: vi.fn(),
	};
	const store: CheckoutRecoveryPersistence = { transaction: async (work) => work(tx) };
	return { tx, enqueue, store, get: () => intent };
}
const now = new Date("2026-09-18T12:00:00Z");
const owner = { id: "i1", ownerType: "USER" as const, ownerId: "u1", actorUserId: "u1", now };
describe("subscription checkout recovery fences", () => {
	it("retains payment evidence inside a cancellation notification", () => {
		expect(
			hasCheckoutFinancialReceipt({
				event_type: "BILLING.SUBSCRIPTION.CANCELLED",
				resource: { billing_info: { last_payment: { amount: { value: "19.00" } } } },
			}),
		).toBe(true);
		expect(
			hasCheckoutFinancialReceipt({
				event_type: "BILLING.SUBSCRIPTION.CREATED",
				resource: { status: "APPROVAL_PENDING" },
			}),
		).toBe(false);
	});
	it("does not close an order whose binding changed during inspection", async () => {
		const f = fixture("LEGACY");
		await requestCheckoutRecoveryWithStore(owner, f.store);
		const claim = await claimCheckoutRecoveryWithStore({ id: "i1", sequence: 1, now }, f.store);
		await f.tx.update("i1", {
			providerOrderId: "other-order",
			checkoutRecovery: readCheckoutRecovery(f.get().checkoutRecovery),
		});
		await finishCheckoutRecoveryWithStore(
			{
				id: "i1",
				leaseToken: claim!.leaseToken,
				status: "CLOSED",
				providerOrderId: "original-order",
				now,
			},
			f.store,
		);
		expect(f.get().status).toBe("PROVIDER_PENDING");
		expect(readCheckoutRecovery(f.get().checkoutRecovery).status).toBe("UNKNOWN");
	});
	it("does not execute an already completed delivery sequence again", async () => {
		const f = fixture();
		await requestCheckoutRecoveryWithStore(owner, f.store);
		const claim = await claimCheckoutRecoveryWithStore({ id: "i1", sequence: 1, now }, f.store);
		await finishCheckoutRecoveryWithStore(
			{ id: "i1", leaseToken: claim!.leaseToken, status: "PAID", now },
			f.store,
		);
		expect(
			await claimCheckoutRecoveryWithStore({ id: "i1", sequence: 1, now }, f.store),
		).toBeNull();
	});
	it("revokes unactivated merchant checkout and denies a late-tab activation", async () => {
		const f = fixture();
		await requestCheckoutRecoveryWithStore(owner, f.store);
		const claim = await claimCheckoutRecoveryWithStore({ id: "i1", sequence: 1, now }, f.store);
		await requestCheckoutRecoveryWithStore({ ...owner, cancel: true }, f.store);
		expect(f.get().status).toBe("CANCELED");
		expect(
			await claimCheckoutActivationWithStore(
				{ id: "i1", leaseToken: claim!.leaseToken, now },
				f.store,
			),
		).toBe(false);
	});
	it("never unlocks a legacy automatically activated checkout by local cancellation", async () => {
		const f = fixture("LEGACY");
		await requestCheckoutRecoveryWithStore({ ...owner, cancel: true }, f.store);
		expect(f.get().status).toBe("PROVIDER_PENDING");
		expect(f.enqueue).toHaveBeenCalledOnce();
	});
	it("keeps activation uncertainty fenced when the user changes plan", async () => {
		const f = fixture();
		await requestCheckoutRecoveryWithStore(owner, f.store);
		const claim = await claimCheckoutRecoveryWithStore({ id: "i1", sequence: 1, now }, f.store);
		expect(
			await claimCheckoutActivationWithStore(
				{ id: "i1", leaseToken: claim!.leaseToken, now },
				f.store,
			),
		).toBe(true);
		await requestCheckoutRecoveryWithStore({ ...owner, cancel: true }, f.store);
		expect(f.get().status).toBe("PROVIDER_PENDING");
	});
	it("rejects stale worker completion after its lease expired", async () => {
		const f = fixture("LEGACY");
		await requestCheckoutRecoveryWithStore(owner, f.store);
		const claim = await claimCheckoutRecoveryWithStore({ id: "i1", sequence: 1, now }, f.store);
		await finishCheckoutRecoveryWithStore(
			{
				id: "i1",
				leaseToken: claim!.leaseToken,
				status: "CLOSED",
				now: new Date(now.getTime() + 100_000),
			},
			f.store,
		);
		expect(f.get().status).toBe("PROVIDER_PENDING");
	});
	it("preserves a cancellation arriving during provider inspection and schedules it", async () => {
		const f = fixture("LEGACY");
		await requestCheckoutRecoveryWithStore(owner, f.store);
		const claim = await claimCheckoutRecoveryWithStore({ id: "i1", sequence: 1, now }, f.store);
		await requestCheckoutRecoveryWithStore({ ...owner, cancel: true }, f.store);
		f.enqueue.mockClear();
		await finishCheckoutRecoveryWithStore(
			{ id: "i1", leaseToken: claim!.leaseToken, status: "PENDING", now },
			f.store,
		);
		expect(f.enqueue).toHaveBeenCalledOnce();
		expect(readCheckoutRecovery(f.get().checkoutRecovery).cancelRequestedAt).toBeDefined();
	});
	it("checks ownership before any mutation", async () => {
		const f = fixture();
		await expect(
			requestCheckoutRecoveryWithStore({ ...owner, ownerId: "attacker", cancel: true }, f.store),
		).rejects.toThrow("CHECKOUT_NOT_FOUND");
		expect(f.get().status).toBe("PROVIDER_PENDING");
	});
});
