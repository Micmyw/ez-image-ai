import { describe, expect, it, vi } from "vitest";

import {
	recoverWaffoSubscriptionCheckout,
	resumeWaffoSubscriptionCheckout,
} from "./checkout-recovery";
import type { WaffoSdkBoundary } from "./waffo";
const input = {
	checkoutIntentId: "i1",
	providerSessionId: "cs1",
	priceId: "p1",
	now: new Date("2026-09-18T12:00:00Z"),
	expiresAt: new Date("2026-09-18T11:59:00Z"),
	cancelRequested: true,
	sessionExpiryVerified: true,
};
const order = {
	id: "ord1",
	status: "pending",
	orderMerchantExternalId: "i1",
	activateAt: null,
	currentPeriodStart: null,
	payments: [],
};
function fixture(orders: unknown[]) {
	const query = vi.fn().mockResolvedValue({ data: { subscriptionOrders: orders } });
	const cancelSubscription = vi.fn().mockResolvedValue({});
	const client = {
		graphql: { query },
		orders: { cancelSubscription },
	} as unknown as WaffoSdkBoundary;
	return { client, query, cancelSubscription };
}
describe("Waffo owned subscription checkout closure", () => {
	it("cancels a pending order and requires readback on the same resource", async () => {
		const f = fixture([order]);
		f.query
			.mockResolvedValueOnce({ data: { subscriptionOrders: [order] } })
			.mockResolvedValueOnce({ data: { subscriptionOrders: [{ ...order, status: "canceled" }] } });
		expect(await recoverWaffoSubscriptionCheckout(f.client, "store", input)).toMatchObject({
			status: "CLOSED",
			providerOrderId: "ord1",
		});
		expect(f.cancelSubscription).toHaveBeenCalledWith({ orderId: "ord1" });
	});
	it("waits for the original checkout session even after order cancellation", async () => {
		const f = fixture([{ ...order, status: "canceled" }]);
		expect(
			await recoverWaffoSubscriptionCheckout(f.client, "store", {
				...input,
				expiresAt: new Date("2026-09-18T12:15:00Z"),
			}),
		).toMatchObject({ status: "WAITING", waitUntil: new Date("2026-09-18T12:15:00Z") });
	});
	it("closes an expired bound session with no order, but not a historical unverified deadline", async () => {
		const f = fixture([]);
		expect(await recoverWaffoSubscriptionCheckout(f.client, "store", input)).toMatchObject({
			status: "CLOSED",
		});
		expect(
			await recoverWaffoSubscriptionCheckout(f.client, "store", {
				...input,
				sessionExpiryVerified: false,
			}),
		).toMatchObject({ status: "UNKNOWN" });
	});
	it.each(["pending", "processing", "unknown"])(
		"preserves an in-flight %s payment after session expiry",
		async (status) => {
			const f = fixture([{ ...order, status: "canceled", payments: [{ status }] }]);
			expect(await recoverWaffoSubscriptionCheckout(f.client, "store", input)).toMatchObject({
				status: "UNKNOWN",
				reason: "PAYMENT_IN_FLIGHT",
			});
			expect(f.cancelSubscription).not.toHaveBeenCalled();
		},
	);
	it("preserves a successful payment even when order cancellation is already reported", async () => {
		const f = fixture([{ ...order, status: "canceled", payments: [{ status: "succeeded" }] }]);
		expect(await recoverWaffoSubscriptionCheckout(f.client, "store", input)).toMatchObject({
			status: "PAID",
		});
	});
	it("does not cancel an order whose binding differs from the stored one", async () => {
		const f = fixture([order]);
		expect(
			await recoverWaffoSubscriptionCheckout(f.client, "store", {
				...input,
				providerOrderId: "another-order",
			}),
		).toMatchObject({ status: "UNKNOWN" });
		expect(f.cancelSubscription).not.toHaveBeenCalled();
	});
	it("does not trust missing history, duplicate orders, warnings or foreign ownership", async () => {
		for (const orders of [
			[{ ...order, status: "canceled", payments: undefined }],
			[order, order],
			[{ ...order, orderMerchantExternalId: "other" }],
		]) {
			const f = fixture(orders);
			expect(await recoverWaffoSubscriptionCheckout(f.client, "store", input)).toMatchObject({
				status: "UNKNOWN",
			});
		}
		const f = fixture([]);
		f.query.mockResolvedValue({ data: { subscriptionOrders: [] }, warnings: ["partial"] });
		expect(await recoverWaffoSubscriptionCheckout(f.client, "store", input)).toMatchObject({
			status: "UNKNOWN",
		});
	});
	it("reads cancellation after a timeout instead of trusting the cancel response", async () => {
		const f = fixture([order]);
		f.cancelSubscription.mockRejectedValue(new Error("timeout"));
		expect(await recoverWaffoSubscriptionCheckout(f.client, "store", input)).toMatchObject({
			status: "UNKNOWN",
		});
		expect(f.query).toHaveBeenCalledTimes(2);
	});
	it("refreshes only the token, keeping the exact original checkout session URL", async () => {
		const issueSessionToken = vi.fn().mockResolvedValue({
			token: "fresh-token",
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		});
		const url = await resumeWaffoSubscriptionCheckout({ auth: { issueSessionToken } } as never, {
			checkoutUrl: "https://pancake.waffo.ai/store/store/checkout/cs1#token=old",
			priceId: "p1",
			ownerType: "USER",
			ownerId: "u1",
		});
		expect(url).toBe("https://pancake.waffo.ai/store/store/checkout/cs1#token=fresh-token");
		expect(issueSessionToken).toHaveBeenCalledWith({ productId: "p1", buyerIdentity: "USER:u1" });
	});
});
