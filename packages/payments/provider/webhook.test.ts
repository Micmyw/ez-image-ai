import { describe, expect, it, vi } from "vitest";

import { createPaymentWebhookHandler } from "./webhook";

describe("shared payment webhook routing", () => {
	it.each([false, true])(
		"wakes the exact durable identity after persistence, including replay=%s",
		async (replayed) => {
			const persist = vi.fn().mockResolvedValue({ replayed, paymentEventId: "stored-event" });
			const wake = vi.fn().mockRejectedValue(new Error("acceptance unknown"));
			const handler = createPaymentWebhookHandler({
				verifiers: {
					stripe: vi.fn().mockResolvedValue({ providerEventId: "provider-event", envelope: {} }),
					paypal: vi.fn(),
					waffo: vi.fn(),
				},
				persist,
			});
			const request = () =>
				new Request("https://app.ezpic.test/api/webhooks/payments", {
					method: "POST",
					headers: { "stripe-signature": "signed" },
					body: "{}",
				});
			expect((await handler(request(), wake)).status).toBe(204);
			expect(wake).toHaveBeenCalledExactlyOnceWith("stored-event");
			expect(persist.mock.invocationCallOrder[0]).toBeLessThan(wake.mock.invocationCallOrder[0]!);
			persist.mockRejectedValue(new Error("transaction rolled back"));
			wake.mockClear();
			expect((await handler(request(), wake)).status).toBe(500);
			expect(wake).not.toHaveBeenCalled();
		},
	);
	it("rejects zero or multiple provider signature candidates before verification", async () => {
		const stripeVerifier = vi.fn();
		const paypalVerifier = vi.fn();
		const persist = vi.fn();
		const handler = createPaymentWebhookHandler({
			verifiers: {
				stripe: stripeVerifier,
				paypal: paypalVerifier,
				waffo: vi.fn(),
			},
			persist,
		});

		await expect(
			handler(new Request("https://app.ezpic.test/api/webhooks/payments", { method: "POST" })),
		).resolves.toMatchObject({ status: 400 });
		await expect(
			handler(
				new Request("https://app.ezpic.test/api/webhooks/payments", {
					method: "POST",
					headers: {
						"stripe-signature": "stripe-signature",
						"paypal-transmission-sig": "paypal-signature",
					},
					body: "{}",
				}),
			),
		).resolves.toMatchObject({ status: 400 });
		expect(stripeVerifier).not.toHaveBeenCalled();
		expect(paypalVerifier).not.toHaveBeenCalled();
		expect(persist).not.toHaveBeenCalled();
	});

	it("persists only the event returned after raw-body verification", async () => {
		const rawBody = '{"id":"delivery-1","data":{"amount":"19.00"}}';
		const verifier = vi.fn().mockResolvedValue({
			providerEventId: "delivery-1",
			normalizedTransactionId: "payment-1",
			providerSubscriptionId: "order-1",
			envelope: { id: "delivery-1", data: { amount: "19.00" } },
		});
		const persist = vi.fn().mockResolvedValue({ replayed: false });
		const handler = createPaymentWebhookHandler({
			verifiers: { stripe: vi.fn(), paypal: vi.fn(), waffo: verifier },
			persist,
		});

		const response = await handler(
			new Request("https://app.ezpic.test/api/webhooks/payments", {
				method: "POST",
				headers: { "x-waffo-signature": "waffo-signature" },
				body: rawBody,
			}),
		);

		expect(response.status).toBe(204);
		expect(verifier).toHaveBeenCalledWith(rawBody, expect.any(Headers));
		expect(persist).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "waffo",
				providerEventId: "delivery-1",
				normalizedTransactionId: "payment-1",
				providerSubscriptionId: "order-1",
				envelope: { id: "delivery-1", data: { amount: "19.00" } },
			}),
		);
	});

	it("never persists an event when signature verification fails", async () => {
		const persist = vi.fn();
		const handler = createPaymentWebhookHandler({
			verifiers: {
				stripe: vi.fn(),
				paypal: vi.fn().mockRejectedValue(new Error("invalid signature")),
				waffo: vi.fn(),
			},
			persist,
		});
		const response = await handler(
			new Request("https://app.ezpic.test/api/webhooks/payments", {
				method: "POST",
				headers: { "paypal-transmission-sig": "paypal-signature" },
				body: '{"id":"WH-1"}',
			}),
		);

		expect(response.status).toBe(400);
		expect(persist).not.toHaveBeenCalled();
	});
});
