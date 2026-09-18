import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
	find: vi.fn(),
	pending: vi.fn(),
	request: vi.fn(),
	dispatch: vi.fn(),
	resume: vi.fn(),
	scope: vi.fn(),
	membership: vi.fn(),
	config: { billingAttachedTo: "user" },
	session: {
		user: { id: "owner-1", isAnonymous: false },
		session: { activeOrganizationId: null as string | null },
	} as {
		user: { id: string; isAnonymous: boolean };
		session: { activeOrganizationId: string | null };
	} | null,
}));
vi.mock("@repo/auth", () => ({ auth: { api: { getSession: async () => state.session } } }));
vi.mock("@repo/database", async () => ({
	...(await import("../../../../database/shared/checkout-recovery")),
	getPaymentCheckoutIntentForOwner: state.find,
	getPendingCheckoutForOwner: state.pending,
	requestCheckoutRecovery: state.request,
}));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/jobs/orchestration/client", () => ({ dispatchJob: state.dispatch }));
vi.mock("@repo/payments", () => ({
	assertCheckoutRecoveryScope: state.scope,
	getPaymentProvider: () => ({ resumeSubscriptionCheckout: state.resume }),
}));
vi.mock("@repo/payments/config", () => ({ config: state.config }));
vi.mock("../../organizations/lib/membership", () => ({
	verifyOrganizationBillingManagement: state.membership,
}));
import {
	getPendingSubscriptionCheckout,
	refreshPendingSubscriptionCheckout,
	cancelPendingSubscriptionCheckout,
	resumePendingSubscriptionCheckout,
} from "./pending-subscription-checkout";
const context = { context: { headers: new Headers() } };
const input = { checkoutIntentId: "intent-1" };
const record = {
	id: "intent-1",
	provider: "paypal",
	productKind: "PLAN",
	ownerType: "USER",
	ownerId: "owner-1",
	planKey: "creator",
	interval: "month",
	status: "PROVIDER_PENDING",
	providerSessionId: "I-1",
	providerCheckoutUrl: "https://paypal.test/approve",
	expiresAt: null,
	billingPlan: { providerPriceId: "P-1" },
	checkoutRecovery: {
		version: 1,
		mode: "MERCHANT",
		sequence: 1,
		status: "CHECKING",
		failures: 0,
		checks: 0,
	},
};
describe("owned durable checkout recovery routes", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		state.config.billingAttachedTo = "user";
		state.session = {
			user: { id: "owner-1", isAnonymous: false },
			session: { activeOrganizationId: null },
		};
		state.pending.mockResolvedValue(record);
		state.find.mockResolvedValue(record);
		state.request.mockResolvedValue(record);
		state.dispatch.mockResolvedValue(undefined);
		state.resume.mockResolvedValue("https://paypal.test/approve");
	});
	it("returns the safe view without checkout URLs or provider resource identifiers", async () => {
		const view = await call(getPendingSubscriptionCheckout, {}, context);
		expect(view).toMatchObject({ id: "intent-1", canResume: true, canChange: true });
		expect(view).not.toHaveProperty("providerSessionId");
		expect(view).not.toHaveProperty("checkoutRecovery");
		expect(view).not.toHaveProperty("providerCheckoutUrl");
	});
	it("persists owned refresh work before best effort dispatch", async () => {
		expect(await call(refreshPendingSubscriptionCheckout, input, context)).toMatchObject({
			status: "CHECKING",
		});
		expect(state.request).toHaveBeenCalledWith(
			{
				id: "intent-1",
				ownerType: "USER",
				ownerId: "owner-1",
				actorUserId: "owner-1",
				cancel: false,
			},
			expect.anything(),
		);
		expect(state.request.mock.invocationCallOrder[0]).toBeLessThan(
			state.dispatch.mock.invocationCallOrder[0]!,
		);
	});
	it("retains durable work when immediate dispatch fails", async () => {
		state.dispatch.mockRejectedValue(new Error("offline"));
		expect(await call(refreshPendingSubscriptionCheckout, input, context)).toMatchObject({
			status: "CHECKING",
		});
	});
	it("explicit change-plan action abandons the owned checkout and reports closure", async () => {
		state.request.mockResolvedValue({ ...record, status: "CANCELED", providerCheckoutUrl: null });
		expect(await call(cancelPendingSubscriptionCheckout, input, context)).toMatchObject({
			status: "CLOSED",
			canResume: false,
			canChange: false,
		});
		expect(state.request).toHaveBeenCalledWith(
			expect.objectContaining({ cancel: true, ownerId: "owner-1" }),
			expect.anything(),
		);
	});
	it("does not expose another owner's checkout", async () => {
		state.request.mockRejectedValue(new Error("CHECKOUT_NOT_FOUND"));
		await expect(call(cancelPendingSubscriptionCheckout, input, context)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(state.dispatch).not.toHaveBeenCalled();
	});
	it("requires organization owner permission for all actions", async () => {
		state.config.billingAttachedTo = "organization";
		state.session!.session.activeOrganizationId = "org-1";
		state.membership.mockResolvedValue(false);
		for (const procedure of [refreshPendingSubscriptionCheckout, cancelPendingSubscriptionCheckout])
			await expect(call(procedure, input, context)).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(call(resumePendingSubscriptionCheckout, input, context)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(state.request).not.toHaveBeenCalled();
		expect(state.find).not.toHaveBeenCalled();
	});
	it("rejects anonymous calls through the real protected middleware", async () => {
		state.session = null;
		await expect(call(cancelPendingSubscriptionCheckout, input, context)).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		expect(state.request).not.toHaveBeenCalled();
	});
	it("rejects browser-supplied provider approval and ownership fields", async () => {
		await expect(
			call(
				refreshPendingSubscriptionCheckout,
				{ ...input, approved: true, ownerId: "attacker" } as never,
				context,
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(state.request).not.toHaveBeenCalled();
	});
	it("renews authentication on the same owned checkout", async () => {
		expect(await call(resumePendingSubscriptionCheckout, input, context)).toEqual({
			checkoutLink: "https://paypal.test/approve",
		});
		expect(state.resume).toHaveBeenCalledWith(
			expect.objectContaining({
				checkoutUrl: record.providerCheckoutUrl,
				ownerId: "owner-1",
				priceId: "P-1",
			}),
		);
	});
	it("does not return a token after concurrent abandonment", async () => {
		state.find
			.mockResolvedValueOnce(record)
			.mockResolvedValueOnce({ ...record, status: "CANCELED" });
		await expect(call(resumePendingSubscriptionCheckout, input, context)).rejects.toMatchObject({
			code: "CONFLICT",
		});
	});
});
