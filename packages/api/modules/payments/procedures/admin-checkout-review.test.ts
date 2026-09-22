import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database", async (original) => ({
	...(await original<typeof import("@repo/database")>()),
	getPaymentCheckoutIntentById: vi.fn(),
	resolveCheckoutReview: vi.fn(),
}));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/payments", async (original) => ({
	...(await original<typeof import("@repo/payments")>()),
	inspectPayPalCheckoutReview: vi.fn(),
}));
import { auth } from "@repo/auth";
import { getPaymentCheckoutIntentById, resolveCheckoutReview } from "@repo/database";
import { inspectPayPalCheckoutReview } from "@repo/payments";

import { paymentsRouter } from "../router";

const read = Reflect.get(paymentsRouter, "getAdminCheckoutReview");
const close = Reflect.get(paymentsRouter, "resolveAdminCheckoutReview");
const context = { context: { headers: new Headers() } };
const at = new Date("2026-09-22T04:00:00Z");
const intent = {
	id: "order-1",
	provider: "paypal",
	productKind: "PLAN",
	status: "PROVIDER_PENDING",
	ownerType: "USER",
	ownerId: "user-1",
	submittedByUserId: "user-1",
	planKey: "studio",
	interval: "month",
	providerSessionId: "I-private",
	providerOrderId: null,
	providerCheckoutUrl: "https://www.paypal.com/private-approval",
	createdAt: at,
	updatedAt: at,
	expiresAt: null,
	billingPlan: { providerPriceId: "P-private", metadata: { providerEnvironment: "live" } },
	checkoutRecovery: {
		version: 1,
		mode: "LEGACY",
		status: "REVIEW",
		sequence: 3,
		failures: 3,
		reason: "RESOURCE_NOT_FOUND",
	},
};
const input = {
	checkoutIntentId: intent.id,
	expectedUpdatedAt: at.toISOString(),
	operationKey: "review-operation-1",
	reason: "Customer left before signing in to PayPal",
	evidenceReference: "Support ticket 2026-09-22-001",
	customerConfirmedNoApproval: true as const,
	merchantRecordsReviewed: true as const,
};
const observation = {
	status: "UNKNOWN",
	reason: "RESOURCE_NOT_FOUND",
	checkedAt: at.toISOString(),
	environment: "live",
	scope: "paypal:scope",
	priceId: "P-private",
	providerSessionId: "I-private",
};
describe("administrator checkout review API", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "admin-1", role: "admin" },
			session: { id: "session-1" },
		} as never);
		vi.mocked(getPaymentCheckoutIntentById).mockResolvedValue(structuredClone(intent) as never);
		vi.mocked(inspectPayPalCheckoutReview).mockResolvedValue(observation as never);
		vi.mocked(resolveCheckoutReview).mockResolvedValue({
			...intent,
			status: "CANCELED",
			providerCheckoutUrl: null,
			checkoutRecovery: { ...intent.checkoutRecovery, status: "CLOSED" },
		} as never);
	});
	it.each([null, "user"])(
		"rejects unauthenticated/non-admin access (%s) before reading or inspecting",
		async (role) => {
			vi.mocked(auth.api.getSession).mockResolvedValue(
				role ? ({ user: { id: "user-1", role }, session: { id: "session-1" } } as never) : null,
			);
			for (const [procedure, value] of [
				[read, { checkoutIntentId: intent.id }],
				[close, input],
			] as const)
				await expect(call(procedure, value, context)).rejects.toMatchObject({
					code: role ? "FORBIDDEN" : "UNAUTHORIZED",
				});
			expect(getPaymentCheckoutIntentById).not.toHaveBeenCalled();
			expect(inspectPayPalCheckoutReview).not.toHaveBeenCalled();
			expect(resolveCheckoutReview).not.toHaveBeenCalled();
		},
	);
	it("returns a reviewable snapshot without provider identifiers or approval URLs", async () => {
		const result = await call(read, { checkoutIntentId: intent.id }, context);
		expect(result).toMatchObject({
			id: intent.id,
			updatedAt: at.toISOString(),
			canReview: true,
			recoveryStatus: "REVIEW",
		});
		expect(JSON.stringify(result)).not.toMatch(/I-private|P-private|private-approval/);
		expect(inspectPayPalCheckoutReview).not.toHaveBeenCalled();
	});
	it("inspects stored bindings freshly and derives the actor from the authenticated session", async () => {
		await expect(call(close, input, context)).resolves.toMatchObject({
			recoveryStatus: "CLOSED",
			canReview: false,
		});
		expect(inspectPayPalCheckoutReview).toHaveBeenCalledWith(
			expect.objectContaining({ providerSessionId: "I-private" }),
		);
		expect(resolveCheckoutReview).toHaveBeenCalledWith(
			expect.objectContaining({
				id: intent.id,
				actorUserId: "admin-1",
				providerObservation: observation,
			}),
			expect.anything(),
		);
	});
	it("rejects forged provider evidence, actor IDs and missing attestations", async () => {
		for (const invalid of [
			{ ...input, providerObservation: observation },
			{ ...input, actorUserId: "forged" },
			{ ...input, merchantRecordsReviewed: false },
		])
			await expect(call(close, invalid as never, context)).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});
		expect(inspectPayPalCheckoutReview).not.toHaveBeenCalled();
		expect(resolveCheckoutReview).not.toHaveBeenCalled();
	});
	it("rejects stale or ineligible snapshots before provider inspection", async () => {
		await expect(
			call(close, { ...input, expectedUpdatedAt: "2026-09-21T04:00:00.000Z" }, context),
		).rejects.toMatchObject({ code: "CONFLICT" });
		vi.mocked(getPaymentCheckoutIntentById).mockResolvedValue({
			...intent,
			checkoutRecovery: { ...intent.checkoutRecovery, activationRequestedAt: at.toISOString() },
		} as never);
		await expect(call(close, input, context)).rejects.toMatchObject({ code: "CONFLICT" });
		expect(inspectPayPalCheckoutReview).not.toHaveBeenCalled();
	});
	it("preserves concurrent database conflicts and sanitizes unexpected failures", async () => {
		vi.mocked(resolveCheckoutReview).mockRejectedValueOnce(
			new Error("CHECKOUT_REVIEW_FINANCIAL_ACTIVITY"),
		);
		await expect(call(close, input, context)).rejects.toMatchObject({
			code: "CONFLICT",
			message: "CHECKOUT_REVIEW_FINANCIAL_ACTIVITY",
		});
		vi.mocked(inspectPayPalCheckoutReview).mockRejectedValueOnce(
			new Error("sensitive upstream response"),
		);
		await expect(call(close, input, context)).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
			message: "CHECKOUT_REVIEW_FAILED",
		});
	});
	it("replays a closed operation through the persisted decision without recontacting PayPal", async () => {
		vi.mocked(getPaymentCheckoutIntentById).mockResolvedValue({
			...intent,
			status: "CANCELED",
			checkoutRecovery: {
				...intent.checkoutRecovery,
				status: "CLOSED",
				resolution: {
					...input,
					actorUserId: "admin-1",
					resolvedAt: at.toISOString(),
				},
			},
		} as never);
		await expect(call(close, input, context)).resolves.toMatchObject({ recoveryStatus: "CLOSED" });
		expect(inspectPayPalCheckoutReview).not.toHaveBeenCalled();
		expect(resolveCheckoutReview).toHaveBeenCalledWith(
			expect.objectContaining({ actorUserId: "admin-1", providerObservation: undefined }),
			expect.anything(),
		);
	});
});
