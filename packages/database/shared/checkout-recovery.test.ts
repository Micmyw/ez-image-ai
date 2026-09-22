import { describe, expect, it, vi } from "vitest";

import * as recovery from "./checkout-recovery";
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
		updatedAt: new Date("2026-09-18T12:00:00Z"),
		checkoutRecovery: { version: 1, mode, sequence: 0, status: "PENDING", failures: 0 },
	};
	const enqueue = vi.fn();
	const audit = vi.fn();
	const hasFinancialActivity = vi.fn().mockResolvedValue(false);
	const tx: CheckoutRecoveryTransaction = {
		lock: vi.fn(),
		lockProvider: vi.fn(),
		find: async () => structuredClone(intent),
		hasFinancialActivity,
		update: async (_id, patch) => {
			intent = { ...intent, ...patch };
			return structuredClone(intent);
		},
		enqueue,
		audit,
	};
	const store: CheckoutRecoveryPersistence = { transaction: async (work) => work(tx) };
	return { tx, enqueue, audit, hasFinancialActivity, store, get: () => intent };
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
	it("keeps exhausted legacy checkout review stable across automatic refreshes", async () => {
		const f = fixture("LEGACY");
		await f.tx.update("i1", {
			checkoutRecovery: {
				...readCheckoutRecovery(f.get().checkoutRecovery),
				status: "REVIEW",
				failures: 3,
				checks: 3,
				sequence: 3,
				reason: "RESOURCE_NOT_FOUND",
			},
		});
		for (const hours of [1, 2, 24]) {
			await requestCheckoutRecoveryWithStore(
				{ ...owner, now: new Date(now.getTime() + hours * 3_600_000) },
				f.store,
			);
		}
		expect(readCheckoutRecovery(f.get().checkoutRecovery)).toMatchObject({
			status: "REVIEW",
			sequence: 3,
			failures: 3,
		});
		expect(f.enqueue).not.toHaveBeenCalled();
		expect(f.audit).not.toHaveBeenCalled();
	});
	it("allows an explicit review retry without resetting the failure history", async () => {
		const f = fixture("LEGACY");
		await f.tx.update("i1", {
			checkoutRecovery: {
				...readCheckoutRecovery(f.get().checkoutRecovery),
				status: "REVIEW",
				failures: 3,
				checks: 3,
				sequence: 3,
			},
		});
		await requestCheckoutRecoveryWithStore(
			{ ...owner, retryReview: true } as typeof owner,
			f.store,
		);
		expect(readCheckoutRecovery(f.get().checkoutRecovery)).toMatchObject({
			status: "CHECKING",
			sequence: 4,
			failures: 3,
		});
		expect(f.enqueue).toHaveBeenCalledOnce();
	});
	it("does not requeue confirmed payment while waiting for ledger fulfillment", async () => {
		const f = fixture();
		await f.tx.update("i1", {
			checkoutRecovery: { ...readCheckoutRecovery(f.get().checkoutRecovery), status: "PAID" },
		});
		await requestCheckoutRecoveryWithStore(owner, f.store);
		expect(readCheckoutRecovery(f.get().checkoutRecovery).status).toBe("PAID");
		expect(f.enqueue).not.toHaveBeenCalled();
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

describe("administrator resolution of abandoned legacy checkout", () => {
	const resolution = {
		id: "i1",
		actorUserId: "admin-1",
		expectedUpdatedAt: now.toISOString(),
		operationKey: "review-operation-1",
		reason: "Customer left before logging in to PayPal",
		evidenceReference: "Support case 2026-09-22-001; merchant records reviewed",
		customerConfirmedNoApproval: true as const,
		merchantRecordsReviewed: true as const,
		providerObservation: {
			status: "UNKNOWN" as const,
			reason: "RESOURCE_NOT_FOUND" as const,
			checkedAt: now.toISOString(),
			environment: "live" as const,
			scope: "paypal:test-scope",
			priceId: "P-1",
			providerSessionId: "I-1",
		},
		now,
	};
	async function reviewed() {
		const f = fixture("LEGACY");
		await f.tx.update("i1", {
			checkoutRecovery: {
				...readCheckoutRecovery(f.get().checkoutRecovery),
				status: "REVIEW",
				failures: 3,
				checks: 3,
				reason: "RESOURCE_NOT_FOUND",
			},
		});
		return f;
	}
	const resolve = async (f: Awaited<ReturnType<typeof reviewed>>, input = resolution) =>
		recovery.resolveCheckoutReviewWithStore(input, f.store);
	it("closes exactly one reviewed unpaid checkout with operator evidence and idempotent replay", async () => {
		const f = await reviewed();
		await expect(resolve(f)).resolves.toMatchObject({
			status: "CANCELED",
			providerCheckoutUrl: null,
		});
		expect(readCheckoutRecovery(f.get().checkoutRecovery)).toMatchObject({
			status: "CLOSED",
			mode: "LEGACY",
		});
		expect(f.audit).toHaveBeenCalledWith(
			expect.anything(),
			"PAYMENT_CHECKOUT_MANUALLY_CLOSED",
			"admin-1",
			expect.objectContaining({
				providerConfirmed: false,
				evidenceReference: resolution.evidenceReference,
			}),
		);
		await expect(resolve(f)).resolves.toMatchObject({ status: "CANCELED" });
		expect(f.audit).toHaveBeenCalledOnce();
		expect(
			await claimCheckoutRecoveryWithStore({ id: "i1", sequence: 0, now }, f.store),
		).toBeNull();
	});
	it("rejects a changed database snapshot before unlocking", async () => {
		const f = await reviewed();
		await expect(
			resolve(f, { ...resolution, expectedUpdatedAt: "2026-09-17T12:00:00Z" }),
		).rejects.toThrow("CHECKOUT_REVIEW_STALE");
		expect(f.get().status).toBe("PROVIDER_PENDING");
	});
	it("rejects financial activity or buyer approval received during provider inspection", async () => {
		const f = await reviewed();
		f.hasFinancialActivity.mockResolvedValue(true);
		await expect(resolve(f)).rejects.toThrow("CHECKOUT_REVIEW_FINANCIAL_ACTIVITY");
		expect(f.get().status).toBe("PROVIDER_PENDING");
		expect(f.audit).not.toHaveBeenCalled();
	});
	it.each(["activation", "lease", "paid"])("retains the fence for %s state", async (condition) => {
		const f = await reviewed();
		await f.tx.update("i1", {
			checkoutRecovery: {
				...readCheckoutRecovery(f.get().checkoutRecovery),
				...(condition === "activation"
					? { activationRequestedAt: now.toISOString() }
					: condition === "lease"
						? { leasedUntil: new Date(now.getTime() + 60_000).toISOString() }
						: { status: "PAID" }),
			},
		});
		await expect(resolve(f)).rejects.toThrow("CHECKOUT_REVIEW_NOT_ELIGIBLE");
		expect(f.get().status).toBe("PROVIDER_PENDING");
	});
	it("rejects missing operator attestations and stale provider evidence", async () => {
		const f = await reviewed();
		await expect(
			resolve(f, { ...resolution, customerConfirmedNoApproval: false } as never),
		).rejects.toThrow("CHECKOUT_REVIEW_EVIDENCE_REQUIRED");
		await expect(
			resolve(f, { ...resolution, now: new Date(now.getTime() + 120_000) }),
		).rejects.toThrow("CHECKOUT_REVIEW_EVIDENCE_REQUIRED");
	});
});
