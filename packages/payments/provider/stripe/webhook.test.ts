import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

import { createStripeWebhookHandler } from "./webhook";
import { getStripeNormalizedTransactionId } from "./webhook";

describe("Stripe webhook", () => {
	it("verifies the raw signature before persistence and returns fast success", async () => {
		const secret = "whsec_test_secret";
		const raw = JSON.stringify({
			id: "evt_invoice_paid",
			object: "event",
			api_version: "2026-07-29.basil",
			created: 1_786_590_000,
			type: "invoice.paid",
			data: { object: { id: "in_paid", object: "invoice" } },
		});
		const signature = Stripe.webhooks.generateTestHeaderString({ payload: raw, secret });
		const persist = vi.fn().mockResolvedValue({ replayed: false });
		const handler = createStripeWebhookHandler({
			stripe: new Stripe("sk_test_fixture"),
			webhookSecret: secret,
			persist,
		});

		const response = await handler(
			new Request("https://example.com/api/webhooks/payments", {
				method: "POST",
				headers: { "stripe-signature": signature },
				body: raw,
			}),
		);

		expect(response.status).toBe(204);
		expect(persist).toHaveBeenCalledOnce();
		expect(persist.mock.calls[0]?.[0]).toMatchObject({
			provider: "stripe",
			providerEventId: "evt_invoice_paid",
		});
	});

	it("does not persist an invalid signature", async () => {
		const persist = vi.fn();
		const handler = createStripeWebhookHandler({
			stripe: new Stripe("sk_test_fixture"),
			webhookSecret: "whsec_test_secret",
			persist,
		});
		const response = await handler(
			new Request("https://example.com/api/webhooks/payments", {
				method: "POST",
				headers: { "stripe-signature": "invalid" },
				body: "{}",
			}),
		);
		expect(response.status).toBe(400);
		expect(persist).not.toHaveBeenCalled();
	});

	it("uses each refund ID rather than the shared charge as its idempotency transaction", () => {
		expect(
			getStripeNormalizedTransactionId({
				type: "refund.created",
				data: { object: { id: "re_first", charge: "ch_shared" } },
			} as never),
		).toBe("refund:re_first");
		expect(
			getStripeNormalizedTransactionId({
				type: "refund.created",
				data: { object: { id: "re_second", charge: "ch_shared" } },
			} as never),
		).toBe("refund:re_second");
	});

	it("namespaces invoice and refund transactions that share a charge", () => {
		expect(
			getStripeNormalizedTransactionId({
				type: "invoice.paid",
				data: { object: { id: "in_paid", charge: "ch_shared" } },
			} as never),
		).toBe("invoice:in_paid");
		expect(
			getStripeNormalizedTransactionId({
				type: "charge.refund.updated",
				data: { object: { id: "re_updated", charge: "ch_shared" } },
			} as never),
		).toBe("refund:re_updated");
	});
});
