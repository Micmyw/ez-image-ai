import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ claim: vi.fn(), activateClaim: vi.fn(), finish: vi.fn() }));
vi.mock("@repo/database", async () => ({
	...(await import("../../database/shared/checkout-recovery")),
	claimCheckoutRecovery: mocks.claim,
	claimCheckoutActivation: mocks.activateClaim,
	finishCheckoutRecovery: mocks.finish,
}));
import { newSubscriptionCheckoutRecovery, recoverSubscriptionCheckout } from "./checkout-recovery";
const environment = {
	PAYPAL_ENVIRONMENT: "sandbox",
	PAYPAL_CLIENT_ID: "sandbox-client",
	PAYPAL_WEBHOOK_ID: "sandbox-hook",
};
const now = new Date("2026-09-18T12:00:00Z");
describe("merchant-controlled subscription activation", () => {
	let inspect: ReturnType<typeof vi.fn>, activate: ReturnType<typeof vi.fn>;
	const intent = () => ({
		id: "i1",
		provider: "paypal",
		status: "PROVIDER_PENDING",
		ownerType: "USER",
		ownerId: "u1",
		providerSessionId: "I-1",
		providerOrderId: null,
		expiresAt: null,
		billingPlan: { providerPriceId: "P-1" },
		checkoutRecovery: newSubscriptionCheckoutRecovery("paypal", environment),
	});
	const run = () =>
		recoverSubscriptionCheckout({ checkoutIntentId: "i1", sequence: 1 }, {} as never, {
			environment,
			now: () => now,
			getProvider: () =>
				({
					name: "paypal",
					recoverSubscriptionCheckout: inspect,
					activateSubscriptionCheckout: activate,
				}) as never,
		});
	beforeEach(() => {
		vi.clearAllMocks();
		inspect = vi.fn().mockResolvedValue({ status: "PENDING" });
		activate = vi.fn();
		mocks.claim.mockResolvedValue({ intent: intent(), leaseToken: "lease" });
		mocks.activateClaim.mockResolvedValue(true);
	});
	it("does not activate an unapproved checkout", async () => {
		mocks.finish.mockResolvedValue({
			billingPlan: { creditsPerPeriod: 700n },
			providerCheckoutUrl: "private",
		});
		expect(await run()).toBeUndefined();
		expect(activate).not.toHaveBeenCalled();
		expect(mocks.finish).toHaveBeenCalledWith(
			expect.objectContaining({ status: "PENDING" }),
			expect.anything(),
		);
	});
	it("claims activation before contacting PayPal and reads back the result", async () => {
		inspect.mockResolvedValueOnce({ status: "APPROVED" }).mockResolvedValueOnce({ status: "PAID" });
		await run();
		expect(mocks.activateClaim.mock.invocationCallOrder[0]).toBeLessThan(
			activate.mock.invocationCallOrder[0]!,
		);
		expect(activate).toHaveBeenCalledWith(
			expect.objectContaining({ checkoutIntentId: "i1", providerSessionId: "I-1", priceId: "P-1" }),
		);
		expect(mocks.finish).toHaveBeenCalledWith(
			expect.objectContaining({ status: "PAID" }),
			expect.anything(),
		);
	});
	it("never activates an abandoned attempt from an old return tab", async () => {
		inspect.mockResolvedValue({ status: "APPROVED" });
		mocks.activateClaim.mockResolvedValue(false);
		await run();
		expect(activate).not.toHaveBeenCalled();
	});
	it("inspects the same resource after an activation timeout and retains uncertainty", async () => {
		inspect.mockResolvedValue({ status: "APPROVED" });
		activate.mockRejectedValue(new Error("timeout"));
		await run();
		expect(inspect).toHaveBeenCalledTimes(2);
		expect(mocks.finish).toHaveBeenCalledWith(
			expect.objectContaining({ status: "ACTIVATING" }),
			expect.anything(),
		);
	});
	it("does not reinterpret an old automatically activated checkout as merchant-controlled", async () => {
		mocks.claim.mockResolvedValue({
			intent: { ...intent(), checkoutRecovery: null },
			leaseToken: "lease",
		});
		inspect.mockResolvedValue({ status: "APPROVED" });
		await run();
		expect(activate).not.toHaveBeenCalled();
	});
	it("refuses a different merchant or environment before provider calls", async () => {
		mocks.claim.mockResolvedValue({
			intent: {
				...intent(),
				checkoutRecovery: {
					...newSubscriptionCheckoutRecovery("paypal", environment),
					environment: "live",
				},
			},
			leaseToken: "lease",
		});
		await run();
		expect(inspect).not.toHaveBeenCalled();
		expect(activate).not.toHaveBeenCalled();
		expect(mocks.finish).toHaveBeenCalledWith(
			expect.objectContaining({ status: "UNKNOWN" }),
			expect.anything(),
		);
	});
	it("does nothing when another worker or closure owns the attempt", async () => {
		mocks.claim.mockResolvedValue(null);
		await run();
		expect(inspect).not.toHaveBeenCalled();
		expect(mocks.finish).not.toHaveBeenCalled();
	});
});
