import { describe, expect, it, vi } from "vitest";

import { listPayPalPaymentEvents } from "./paypal/event-source";
import { listWaffoPaymentEvents } from "./waffo/event-source";

const window = {
	since: new Date("2026-09-01T00:00:00Z"),
	until: new Date("2026-09-02T00:00:00Z"),
	cursor: null,
	limit: 50,
};

describe("authenticated provider event backfill", () => {
	it("retrieves PayPal event notifications and preserves original idempotency identities", async () => {
		const event = {
			id: "WH-PAID",
			event_type: "PAYMENT.SALE.COMPLETED",
			create_time: "2026-09-01T10:00:00Z",
			resource: { id: "SALE-1", billing_agreement_id: "I-1" },
		};
		const request = vi.fn().mockResolvedValue({
			status: 200,
			body: {
				events: [event],
				links: [
					{
						rel: "next",
						href: "https://api-m.sandbox.paypal.com/v1/notifications/webhooks-events?page=2",
					},
				],
			},
		});
		const result = await listPayPalPaymentEvents(
			{ request },
			{ baseUrl: "https://api-m.sandbox.paypal.com", accessToken: "test" },
			window,
		);
		expect(result.events).toEqual([
			{ providerEventId: "WH-PAID", providerSubscriptionId: "I-1", envelope: event },
		]);
		expect(result.nextCursor).toContain("page=2");
	});

	it("rejects an off-origin provider pagination link before sending credentials", async () => {
		const request = vi.fn();
		await expect(
			listPayPalPaymentEvents(
				{ request },
				{ baseUrl: "https://api-m.paypal.com", accessToken: "test" },
				{ ...window, cursor: "https://attacker.example/collect" },
			),
		).rejects.toThrow("PAYPAL_RECONCILIATION_CURSOR_INVALID");
		expect(request).not.toHaveBeenCalled();
	});

	it("retrieves Waffo original HTTP envelopes, including failed deliveries, without inventing receipt periods", async () => {
		const envelope = {
			id: "delivery",
			eventId: "PAY-1",
			eventType: "subscription.payment_succeeded",
			storeId: "store-1",
			mode: "test",
			timestamp: "2026-09-01T10:00:00Z",
			data: { orderId: "ORD-1", paymentId: "PAY-1", amount: "19.00" },
		};
		const query = vi.fn().mockResolvedValue({
			data: {
				webhookDeliveries: [{ payload: JSON.stringify(envelope) }],
				webhookDeliveriesCount: 1,
			},
		});
		const result = await listWaffoPaymentEvents(
			{ graphql: { query } },
			{ storeId: "store-1", environment: "test" },
			window,
		);
		expect(result.events[0]).toMatchObject({ providerSubscriptionId: "ORD-1", envelope });
		expect(result.nextCursor).toBeNull();
		expect(query.mock.calls[0]![0].query).not.toContain("status:");
	});

	it("rejects sandbox or other-store data in the production backfill", async () => {
		const query = vi.fn().mockResolvedValue({
			data: {
				webhookDeliveries: [{ payload: JSON.stringify({ storeId: "store-1", mode: "test" }) }],
				webhookDeliveriesCount: 1,
			},
		});
		await expect(
			listWaffoPaymentEvents(
				{ graphql: { query } },
				{ storeId: "store-1", environment: "prod" },
				window,
			),
		).rejects.toThrow("WAFFO_RECONCILIATION_SCOPE_INVALID");
	});
});
