import Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { loggerError } = vi.hoisted(() => ({ loggerError: vi.fn() }));

vi.mock("@repo/logs", () => ({
	logger: { error: loggerError },
}));

import { createStripeWebhookHandler, createStripeWebhookVerifier } from "./webhook";
import { getStripeNormalizedTransactionId } from "./webhook";

describe("Stripe webhook", () => {
	beforeEach(() => {
		loggerError.mockReset();
	});

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

	it("exposes the verified event envelope for shared provider routing", async () => {
		const secret = "whsec_shared_router";
		const raw = JSON.stringify({
			id: "evt_shared_router",
			object: "event",
			api_version: "2026-07-29.dahlia",
			created: 1_786_590_000,
			type: "invoice.paid",
			data: { object: { id: "in_shared_router" } },
		});
		const signature = Stripe.webhooks.generateTestHeaderString({ payload: raw, secret });
		const verifier = createStripeWebhookVerifier({
			stripe: new Stripe("sk_test_fixture"),
			webhookSecret: secret,
		});

		await expect(verifier(raw, new Headers({ "stripe-signature": signature }))).resolves.toEqual({
			providerEventId: "evt_shared_router",
			normalizedTransactionId: "invoice:in_shared_router",
			envelope: expect.objectContaining({ id: "evt_shared_router", type: "invoice.paid" }),
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

	it("logs only an allowlisted database failure class when persistence fails", async () => {
		const secret = "whsec_test_secret";
		const leakedValue = "raw-envelope-must-not-reach-logs";
		const raw = JSON.stringify({
			id: "evt_persistence_failed",
			object: "event",
			api_version: "2026-07-29.dahlia",
			created: 1_786_590_000,
			type: "invoice.paid",
			data: { object: { id: "in_failed", private_note: leakedValue } },
		});
		const signature = Stripe.webhooks.generateTestHeaderString({ payload: raw, secret });
		const persistenceError = Object.assign(new Error(`database failed: ${leakedValue}`), {
			code: "P1001",
			rawEnvelope: { privateNote: leakedValue },
		});
		const handler = createStripeWebhookHandler({
			stripe: new Stripe("sk_test_fixture"),
			webhookSecret: secret,
			persist: vi.fn().mockRejectedValue(persistenceError),
		});

		const response = await handler(
			new Request("https://example.com/api/webhooks/payments", {
				method: "POST",
				headers: { "stripe-signature": signature },
				body: raw,
			}),
		);

		expect(response.status).toBe(500);
		expect(loggerError).toHaveBeenCalledWith(
			{
				errorClass: "DATABASE_UNAVAILABLE",
				providerEventId: "evt_persistence_failed",
			},
			"Stripe payment event persistence failed",
		);
		expect(JSON.stringify(loggerError.mock.calls)).not.toContain(leakedValue);
	});

	it("uses each refund ID rather than the shared charge as its idempotency transaction", () => {
		for (const type of [
			"refund.created",
			"refund.updated",
			"refund.failed",
			"charge.refund.updated",
		] as const) {
			expect(
				getStripeNormalizedTransactionId({
					type,
					data: {
						object: { id: "re_first", charge: "ch_shared", payment_intent: "pi_shared" },
					},
				} as never),
			).toBe("refund:re_first");
		}
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
