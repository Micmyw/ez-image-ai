import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
	find: vi.fn(),
	close: vi.fn(),
	inspect: vi.fn(),
	membership: vi.fn(),
	config: { billingAttachedTo: "user" },
	session: {
		user: { id: "owner-1", isAnonymous: false },
		session: { activeOrganizationId: null as string | null },
	},
}));
vi.mock("@repo/auth", () => ({ auth: { api: { getSession: async () => state.session } } }));
vi.mock("@repo/database", () => ({
	getPaymentCheckoutIntentForOwner: state.find,
	closeConfirmedPaymentCheckoutIntent: state.close,
}));
vi.mock("@repo/database/client", () => ({
	db: { paymentCheckoutIntent: { findFirst: state.find } },
}));
vi.mock("@repo/payments", () => ({
	getPaymentProvider: () => ({ inspectCheckout: state.inspect }),
}));
vi.mock("@repo/payments/config", () => ({ config: state.config }));
vi.mock("../../organizations/lib/membership", () => ({
	verifyOrganizationBillingManagement: state.membership,
}));
import { refreshPendingSubscriptionCheckout } from "./pending-subscription-checkout";
const invoke = () =>
	call(
		refreshPendingSubscriptionCheckout,
		{ checkoutIntentId: "intent-1" },
		{ context: { headers: new Headers() } },
	);

describe("pending subscription recovery", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		state.config.billingAttachedTo = "user";
		state.session.session.activeOrganizationId = null;
		state.find.mockResolvedValue({
			id: "intent-1",
			productKind: "PLAN",
			provider: "paypal",
			status: "PROVIDER_PENDING",
			providerSessionId: "I-1",
			expiresAt: null,
			billingPlan: { providerPriceId: "P-1" },
		});
		state.close.mockResolvedValue(true);
	});
	it("keeps an unapproved PayPal link recoverable without allowing a second checkout", async () => {
		state.inspect.mockResolvedValue("PENDING");
		expect(await invoke()).toEqual({ status: "PENDING" });
		expect(state.close).not.toHaveBeenCalled();
		expect(state.find).toHaveBeenCalledWith(
			{ ownerType: "USER", ownerId: "owner-1", intentId: "intent-1" },
			expect.anything(),
		);
	});
	it("releases admission only after provider closure with the same original session", async () => {
		state.inspect.mockResolvedValue("CLOSED");
		expect(await invoke()).toEqual({ status: "CLOSED" });
		expect(state.close).toHaveBeenCalledWith(
			expect.objectContaining({
				expectedStatus: "PROVIDER_PENDING",
				expectedProviderSessionId: "I-1",
				ownerId: "owner-1",
			}),
			expect.anything(),
		);
	});
	it("keeps admission blocked on provider timeout or activation racing the browser", async () => {
		state.inspect.mockRejectedValueOnce(new Error("timeout"));
		expect(await invoke()).toEqual({ status: "UNKNOWN" });
		state.inspect.mockResolvedValueOnce("PAID");
		expect(await invoke()).toEqual({ status: "PAID" });
		expect(state.close).not.toHaveBeenCalled();
	});
	it("cannot inspect or close another owner checkout", async () => {
		state.find.mockResolvedValue(null);
		await expect(invoke()).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(state.inspect).not.toHaveBeenCalled();
	});
	it("requires organization billing management permission", async () => {
		state.config.billingAttachedTo = "organization";
		state.session.session.activeOrganizationId = "org-1";
		state.membership.mockResolvedValue(false);
		await expect(invoke()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(state.find).not.toHaveBeenCalled();
	});
});
