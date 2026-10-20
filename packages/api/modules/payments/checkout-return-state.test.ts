import { ORPCError } from "@orpc/client";
import { call } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	getIntent: vi.fn(),
	findSubscription: vi.fn(),
}));
vi.mock("@repo/auth", () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock("@repo/database", async () => ({
	getPaymentCheckoutIntentForOwner: mocks.getIntent,
	readCheckoutRecovery: (await import("../../../database/shared/checkout-recovery"))
		.readCheckoutRecovery,
}));
vi.mock("@repo/database/client", () => ({
	db: { subscription: { findFirst: mocks.findSubscription } },
}));

import {
	assertCheckoutReturnOwnerScope,
	getCheckoutReturnState,
	resolveCheckoutReturnState,
} from "./procedures/get-checkout-return-state";

const now = new Date("2026-08-25T06:00:00Z");
const start = new Date("2026-08-25T00:00:00Z");
const end = new Date("2026-09-25T00:00:00Z");
const pending = { status: "PENDING", planId: null, paidThrough: null };
function paidSubscription() {
	return {
		status: "ACTIVE",
		graceEndsAt: null as Date | null,
		plan: { metadata: { planId: "creator" }, name: "creator" },
		currentPeriodStart: start,
		currentPeriodEnd: end,
		periods: [
			{ startsAt: start, endsAt: end, paidAmount: 19000000n, refundedAmount: 0n, status: "ACTIVE" },
		],
	};
}

describe("checkout return ownership and paid confirmation", () => {
	it("cannot confirm an old subscription fenced by refund termination", () => {
		expect(
			resolveCheckoutReturnState(
				{ ...paidSubscription(), refundTerminationRequestedAt: now },
				"creator",
				now,
			),
		).toEqual(pending);
	});
	it("rejects organization scope in the user-only first release", () => {
		expect(() => assertCheckoutReturnOwnerScope("org-other")).toThrow(ORPCError);
	});
	it("accepts the authenticated user scope", () => {
		expect(() => assertCheckoutReturnOwnerScope(undefined)).not.toThrow();
	});
	it("waits for actual payment even after provider activation", () => {
		expect(
			resolveCheckoutReturnState({ ...paidSubscription(), periods: [] }, "creator", now),
		).toEqual(pending);
	});
	it("waits for the plan selected by the customer", () => {
		expect(resolveCheckoutReturnState(paidSubscription(), "studio", now)).toEqual(pending);
	});
	it.each(["ACTIVE", "CANCELED"])("confirms %s only during the paid period", (status) => {
		const subscription = { ...paidSubscription(), status };
		expect(resolveCheckoutReturnState(subscription, "creator", now)).toEqual({
			status: "ACTIVE",
			planId: "creator",
			paidThrough: end,
		});
		expect(resolveCheckoutReturnState(subscription, "creator", end)).toEqual(pending);
	});
	it("does not confirm a fully refunded payment", () => {
		const subscription = paidSubscription();
		subscription.periods[0]!.refundedAmount = 19000000n;
		expect(resolveCheckoutReturnState(subscription, "creator", now)).toEqual(pending);
	});
	it("keeps partial-refund feature access even if this month's credits were clawed back first", () => {
		const subscription = paidSubscription();
		subscription.periods[0]!.refundedAmount = 9500000n;
		subscription.periods[0]!.status = "REFUNDED";
		expect(resolveCheckoutReturnState(subscription, "creator", now).status).toBe("ACTIVE");
	});
	it("honors the exact grace boundary with prior payment evidence", () => {
		const subscription = {
			...paidSubscription(),
			status: "PAST_DUE",
			graceEndsAt: new Date(now.getTime() + 1),
		};
		expect(resolveCheckoutReturnState(subscription, "creator", now).status).toBe("PAST_DUE");
		expect(resolveCheckoutReturnState(subscription, "creator", subscription.graceEndsAt)).toEqual(
			pending,
		);
		expect(resolveCheckoutReturnState({ ...subscription, periods: [] }, "creator", now)).toEqual(
			pending,
		);
	});
	it("does not confirm grace using an older payment after the latest paid period was refunded", () => {
		const subscription = { ...paidSubscription(), status: "PAST_DUE", graceEndsAt: end };
		subscription.periods[0]!.refundedAmount = 19000000n;
		subscription.periods[0]!.status = "REFUNDED";
		subscription.periods.unshift({
			startsAt: new Date("2026-07-25T00:00:00Z"),
			endsAt: start,
			paidAmount: 19000000n,
			refundedAmount: 0n,
			status: "CLOSED",
		});
		expect(resolveCheckoutReturnState(subscription, "creator", now)).toEqual(pending);
	});
	it("does not use a future paid period to confirm grace early", () => {
		const subscription = { ...paidSubscription(), status: "PAST_DUE", graceEndsAt: end };
		subscription.periods[0]!.startsAt = new Date(now.getTime() + 1);
		expect(resolveCheckoutReturnState(subscription, "creator", now)).toEqual(pending);
	});
	it("preserves grace after an unpaid renewal when the last actual payment was not fully refunded", () => {
		const subscription = { ...paidSubscription(), status: "PAST_DUE", graceEndsAt: end };
		subscription.periods[0]!.paidAmount = 0n;
		subscription.periods[0]!.status = "PENDING";
		subscription.periods.push({
			startsAt: new Date("2026-07-25T00:00:00Z"),
			endsAt: start,
			paidAmount: 19000000n,
			refundedAmount: 0n,
			status: "CLOSED",
		});
		expect(resolveCheckoutReturnState(subscription, "creator", now).status).toBe("PAST_DUE");
	});
	it("uses the canonical legacy plan name and supports Ultimate", () => {
		expect(
			resolveCheckoutReturnState(
				{ ...paidSubscription(), plan: { metadata: {} as { planId: string }, name: "ultimate" } },
				"ultimate",
				now,
			).planId,
		).toBe("ultimate");
	});
});

function completedIntent(provider: "paypal" | "waffo" = "paypal") {
	return {
		id: "checkout-current",
		ownerType: "USER",
		ownerId: "owner-a",
		productKind: "PLAN",
		provider,
		status: "COMPLETED",
		planKey: "creator",
		billingPlanId: "billing-creator",
		billingPlan: {
			id: "billing-creator",
			provider,
			productKind: "PLAN",
			name: "creator",
		},
		providerSessionId: provider === "paypal" ? "subscription-current" : "checkout-session",
		providerOrderId: provider === "waffo" ? "subscription-current" : null,
	};
}
function boundSubscription(provider: "paypal" | "waffo" = "paypal") {
	return {
		...paidSubscription(),
		provider,
		providerSubscriptionId: "subscription-current",
		ownerType: "USER",
		ownerId: "owner-a",
		planId: "billing-creator",
		refundTerminationRequestedAt: null,
	};
}
function readReturn(input: { checkoutIntentId?: string; organizationId?: string } = {}) {
	return call(
		getCheckoutReturnState,
		{ expectedPlanId: "creator", ...input },
		{ context: { headers: new Headers() } },
	);
}

describe("checkout-specific subscription payment confirmation", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		vi.resetAllMocks();
		mocks.getSession.mockResolvedValue({
			session: { activeOrganizationId: null },
			user: { id: "owner-a", isAnonymous: false },
		});
		mocks.getIntent.mockResolvedValue(completedIntent());
		mocks.findSubscription.mockResolvedValue(boundSubscription());
	});
	afterEach(() => vi.useRealTimers());

	it("does not mistake an existing same-plan subscription for a legacy checkout without an intent", async () => {
		await expect(readReturn()).resolves.toEqual(pending);
		expect(mocks.getIntent).not.toHaveBeenCalled();
		expect(mocks.findSubscription).not.toHaveBeenCalled();
	});
	it("does not confirm a new pending checkout using an older paid subscription", async () => {
		mocks.getIntent.mockResolvedValue({ ...completedIntent(), status: "PROVIDER_PENDING" });
		await expect(readReturn({ checkoutIntentId: "checkout-current" })).resolves.toEqual(pending);
		expect(mocks.findSubscription).not.toHaveBeenCalled();
	});
	it.each(["paypal", "waffo"] as const)(
		"confirms only the %s resource bound to the owned completed checkout",
		async (provider) => {
			const intent = completedIntent(provider);
			mocks.getIntent.mockResolvedValue(intent);
			mocks.findSubscription.mockImplementation(async ({ where }) =>
				where.provider === provider &&
				where.providerSubscriptionId === "subscription-current" &&
				where.ownerType === "USER" &&
				where.ownerId === "owner-a" &&
				where.planId === "billing-creator"
					? boundSubscription(provider)
					: null,
			);
			await expect(readReturn({ checkoutIntentId: intent.id })).resolves.toEqual({
				status: "ACTIVE",
				planId: "creator",
				paidThrough: end,
			});
			expect(mocks.getIntent).toHaveBeenCalledWith(
				{ intentId: intent.id, ownerType: "USER", ownerId: "owner-a" },
				expect.anything(),
			);
		},
	);
	it.each(["REVIEW", "EXPIRED", "CANCELED"])(
		"reports this checkout's %s state without borrowing old paid rights",
		async (status) => {
			mocks.getIntent.mockResolvedValue({ ...completedIntent(), status });
			await expect(readReturn({ checkoutIntentId: "checkout-current" })).resolves.toEqual({
				status,
				planId: null,
				paidThrough: null,
			});
			expect(mocks.findSubscription).not.toHaveBeenCalled();
		},
	);
	it.each([
		["PROVIDER_PENDING", "REVIEW"],
		["COMPLETED", "ACTIVE"],
		["CANCELED", "CANCELED"],
	])("shows recovery review for %s without overriding %s", async (intentStatus, expectedStatus) => {
		mocks.getIntent.mockResolvedValue({
			...completedIntent(),
			status: intentStatus,
			checkoutRecovery: { version: 1, mode: "MERCHANT", status: "REVIEW" },
		});
		const result = await readReturn({ checkoutIntentId: "checkout-current" });
		expect(result.status).toBe(expectedStatus);
		if (expectedStatus !== "ACTIVE") {
			expect(result.planId).toBeNull();
			expect(result.paidThrough).toBeNull();
			expect(mocks.findSubscription).not.toHaveBeenCalled();
		}
	});
	it.each([
		["unknown owner", null],
		["different owner", { ...completedIntent(), ownerId: "owner-b" }],
		["non-plan product", { ...completedIntent(), productKind: "CREDIT_PACK" }],
		["unsupported provider", { ...completedIntent(), provider: "stripe" }],
		["different selected plan", { ...completedIntent(), planKey: "ultimate" }],
		[
			"different billing provider",
			{
				...completedIntent(),
				billingPlan: { ...completedIntent().billingPlan, provider: "waffo" },
			},
		],
		[
			"non-plan billing product",
			{
				...completedIntent(),
				billingPlan: { ...completedIntent().billingPlan, productKind: "CREDIT_PACK" },
			},
		],
		[
			"different frozen billing plan",
			{ ...completedIntent(), billingPlan: { ...completedIntent().billingPlan, id: "other-plan" } },
		],
	])("does not reveal a checkout with %s", async (_reason, intent) => {
		mocks.getIntent.mockResolvedValue(intent);
		await expect(readReturn({ checkoutIntentId: "checkout-current" })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(mocks.findSubscription).not.toHaveBeenCalled();
	});
	it("keeps a completed checkout unconfirmed without its provider resource", async () => {
		mocks.getIntent.mockResolvedValue({ ...completedIntent(), providerSessionId: null });
		await expect(readReturn({ checkoutIntentId: "checkout-current" })).resolves.toEqual(pending);
		expect(mocks.findSubscription).not.toHaveBeenCalled();
	});
	it.each([
		["different owner", { ...boundSubscription(), ownerId: "owner-b" }],
		["different provider", { ...boundSubscription(), provider: "waffo" }],
		["different resource", { ...boundSubscription(), providerSubscriptionId: "subscription-old" }],
		["different plan", { ...boundSubscription(), planId: "billing-old" }],
	])("cannot confirm an unrelated subscription with %s", async (_reason, subscription) => {
		mocks.findSubscription.mockResolvedValue(subscription);
		await expect(readReturn({ checkoutIntentId: "checkout-current" })).resolves.toEqual(pending);
	});
	it("waits for a paid period after activation completed the intent", async () => {
		mocks.findSubscription.mockResolvedValue({ ...boundSubscription(), periods: [] });
		await expect(readReturn({ checkoutIntentId: "checkout-current" })).resolves.toEqual(pending);
	});
	it("does not confirm a completed checkout after full refund", async () => {
		const subscription = boundSubscription();
		subscription.periods[0]!.refundedAmount = subscription.periods[0]!.paidAmount;
		mocks.findSubscription.mockResolvedValue(subscription);
		await expect(readReturn({ checkoutIntentId: "checkout-current" })).resolves.toEqual(pending);
	});
	it("preserves the existing prior-paid grace result for this checkout's subscription", async () => {
		mocks.findSubscription.mockResolvedValue({
			...boundSubscription(),
			status: "PAST_DUE",
			graceEndsAt: end,
		});
		await expect(readReturn({ checkoutIntentId: "checkout-current" })).resolves.toEqual({
			status: "PAST_DUE",
			planId: "creator",
			paidThrough: end,
		});
	});
	it("keeps organization queries outside the user-only return scope", async () => {
		await expect(
			readReturn({ checkoutIntentId: "checkout-current", organizationId: "org-other" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.getIntent).not.toHaveBeenCalled();
		expect(mocks.findSubscription).not.toHaveBeenCalled();
	});
});
