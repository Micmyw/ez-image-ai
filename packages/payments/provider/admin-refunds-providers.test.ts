import { generateKeyPairSync, createHash, createVerify } from "node:crypto";

import type { AdminRefundPayment } from "@repo/database";
import { describe, expect, it, vi } from "vitest";

import { createPayPalAdminRefundAdapter } from "./admin-refunds-paypal";
import { createStripeAdminRefundAdapter } from "./admin-refunds-stripe";
import type { AdminRefundRequestRecord } from "./admin-refunds-types";
import {
	createWaffoAdminRefundAdapter,
	createWaffoAdminRefundBoundary,
} from "./admin-refunds-waffo";
import { createPayPalHttpBoundary } from "./paypal";

const payment: AdminRefundPayment = {
	orderNo: "pack:1",
	productKind: "CREDIT_PACK",
	ownerType: "USER",
	ownerId: "user-1",
	provider: "paypal",
	paymentKey: "paypal:CAPTURE-1",
	providerPaymentId: "CAPTURE-1",
	providerOrderId: "ORDER-1",
	providerInvoiceId: null,
	providerChargeId: null,
	providerPaymentIntentId: null,
	providerSubscriptionId: null,
	subscriptionId: null,
	purchaseId: "purchase-1",
	checkoutIntentId: "checkout-1",
	priceId: "price-1",
	providerEnvironment: "sandbox",
	amountMicros: 59_000_000n,
	refundedAmountMicros: 0n,
	currency: "USD",
	paidAt: new Date("2026-10-01T00:00:00Z"),
	creditsRequested: 1500n,
	cancellationPolicyRequired: false,
};
const request: AdminRefundRequestRecord = {
	id: "request-1",
	paymentKey: payment.paymentKey,
	orderNo: payment.orderNo,
	ownerType: "USER",
	ownerId: "user-1",
	provider: "paypal",
	providerEnvironment: "sandbox",
	productKind: "CREDIT_PACK",
	providerPaymentId: payment.providerPaymentId,
	providerOrderId: payment.providerOrderId,
	subscriptionId: null,
	amountMicros: 59_000_000n,
	currency: "USD",
	status: "PROCESSING",
	providerRequestId: "ezr-stable-reference",
	providerRefundId: null,
	reason: "Requested",
	cancelSubscription: false,
	requestedBy: "admin-1",
	processingToken: "token-1",
	processingLeasedUntil: new Date(Date.now() + 60_000),
	providerAcceptedAt: null,
	completedAt: null,
	lastError: null,
	result: null,
	createdAt: new Date("2026-10-20T00:00:00Z"),
	updatedAt: new Date(),
};
const paypalEnvironment = {
	PAYPAL_ENVIRONMENT: "sandbox",
	PAYPAL_CLIENT_ID: "test-id",
	PAYPAL_CLIENT_SECRET: "test-secret",
};
const paypalRefund = {
	id: "REFUND-1",
	status: "COMPLETED",
	amount: { value: "59.00", currency_code: "USD" },
	create_time: "2026-10-20T00:00:10Z",
	links: [{ rel: "up", href: "https://api-m.sandbox.paypal.com/v2/payments/captures/CAPTURE-1" }],
};

describe("PayPal admin refunds", () => {
	it.each([301, 302, 303, 307, 308])(
		"keeps HTTP %s as unknown and prevents OAuth/refund redirects at the shared fetch boundary",
		async (status) => {
			const fetchImplementation = vi
				.fn()
				.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "token" })))
				.mockResolvedValueOnce(
					new Response(JSON.stringify(paypalRefund), {
						status,
						headers: { Location: "https://redirect.invalid/refund" },
					}),
				);
			const adapter = createPayPalAdminRefundAdapter(
				paypalEnvironment,
				createPayPalHttpBoundary(fetchImplementation),
			);
			expect(await adapter.submit(payment, request)).toEqual({
				status: "UNKNOWN",
				error: "PAYPAL_REFUND_SUBMISSION_UNCONFIRMED",
			});
			expect(fetchImplementation).toHaveBeenCalledTimes(2);
			for (const [url, options] of fetchImplementation.mock.calls) {
				expect(new URL(url).origin).toBe("https://api-m.sandbox.paypal.com");
				expect(options.redirect).toBe("manual");
			}
		},
	);
	it("uses persisted request id and server amount, then retrieves the original capture-bound refund", async () => {
		const http = {
			request: vi
				.fn()
				.mockResolvedValueOnce({ status: 200, body: { access_token: "token" } })
				.mockResolvedValueOnce({ status: 201, body: { id: "REFUND-1", status: "COMPLETED" } })
				.mockResolvedValueOnce({ status: 200, body: paypalRefund }),
		};
		const result = await createPayPalAdminRefundAdapter(paypalEnvironment, http).submit(
			payment,
			request,
		);
		expect(result.status).toBe("SUCCEEDED");
		expect(http.request.mock.calls[1]![0]).toMatchObject({
			method: "POST",
			headers: { "PayPal-Request-Id": request.providerRequestId },
			body: {
				amount: { value: "59.00", currency_code: "USD" },
				invoice_id: request.providerRequestId,
			},
		});
		expect(http.request.mock.calls[2]![0].method).toBe("GET");
	});
	it("does not call a pending response successful and keeps identity on failed retrieval", async () => {
		const http = {
			request: vi
				.fn()
				.mockResolvedValueOnce({ status: 200, body: { access_token: "token" } })
				.mockResolvedValueOnce({ status: 201, body: { id: "REFUND-1" } })
				.mockResolvedValueOnce({ status: 200, body: { ...paypalRefund, status: "PENDING" } }),
		};
		expect(
			await createPayPalAdminRefundAdapter(paypalEnvironment, http).submit(payment, request),
		).toEqual({ status: "PROCESSING", providerRefundId: "REFUND-1" });
	});
	it("recovers a lost refund response through authenticated event and refund GET without another refund POST", async () => {
		const http = {
			request: vi
				.fn()
				.mockResolvedValueOnce({ status: 200, body: { access_token: "token" } })
				.mockResolvedValueOnce({
					status: 200,
					body: {
						events: [
							{
								id: "WH-1",
								event_type: "PAYMENT.CAPTURE.REFUNDED",
								create_time: "2026-10-20T00:00:10Z",
								resource: paypalRefund,
							},
						],
					},
				})
				.mockResolvedValueOnce({ status: 200, body: paypalRefund }),
		};
		expect(
			(await createPayPalAdminRefundAdapter(paypalEnvironment, http).inspect(payment, request))
				.status,
		).toBe("SUCCEEDED");
		expect(http.request.mock.calls.filter(([input]) => input.method === "POST")).toHaveLength(1); // OAuth only
		expect(http.request.mock.calls.some(([input]) => input.url.endsWith("/refund"))).toBe(false);
	});
	it("rejects a refund bound to another capture and an environment mismatch", async () => {
		const http = {
			request: vi
				.fn()
				.mockResolvedValueOnce({ status: 200, body: { access_token: "token" } })
				.mockResolvedValueOnce({ status: 200, body: { ...paypalRefund, links: [] } }),
		};
		await expect(
			createPayPalAdminRefundAdapter(paypalEnvironment, http).inspect(payment, {
				...request,
				providerRefundId: "REFUND-1",
			}),
		).rejects.toThrow("PAYPAL_REFUND_BINDING_MISMATCH");
		await expect(
			createPayPalAdminRefundAdapter(paypalEnvironment, http).verifyPayment({
				...payment,
				providerEnvironment: "live",
			}),
		).rejects.toThrow("ADMIN_REFUND_ENVIRONMENT_MISMATCH");
	});
});

const waffoEnvironment = { WAFFO_ENVIRONMENT: "test", WAFFO_STORE_ID: "STORE-1" };
const waffoPayment = { ...payment, provider: "waffo", providerEnvironment: "test" };
const waffoRequest = { ...request, provider: "waffo", providerEnvironment: "test" };
const ticket = {
	id: "TICKET-1",
	subjectId: payment.providerPaymentId,
	status: "approved",
	refundTicketMerchantExternalId: request.providerRequestId,
	versionData: { requestedAmount: { amount: "59.00", currency: "USD" } },
};
describe("Waffo merchant refunds", () => {
	it("keeps an approved/executed ticket pending until an actual successful refund exists", async () => {
		const boundary = {
			createTicket: vi.fn().mockResolvedValue({ status: 200, body: { data: { ticket } } }),
			query: vi.fn().mockResolvedValue({
				data: {
					refundTickets: [{ ...ticket, executedAt: new Date().toISOString() }],
					refunds: [],
				},
			}),
		};
		expect(
			await createWaffoAdminRefundAdapter(waffoEnvironment, boundary).submit(
				waffoPayment,
				waffoRequest,
			),
		).toEqual({ status: "PROCESSING" });
		expect(boundary.createTicket).toHaveBeenCalledWith(
			expect.objectContaining({
				paymentId: payment.providerPaymentId,
				refundTicketMerchantExternalId: request.providerRequestId,
				requestedAmount: { amount: "59.00", currency: "USD" },
			}),
		);
	});
	it("retrieves the exact ticket reference and verifies refund payment, amount and environment", async () => {
		const refund = {
			id: "REFUND-1",
			paymentId: payment.providerPaymentId,
			testMode: true,
			status: "succeeded",
			refundTicketMerchantExternalId: request.providerRequestId,
			amount: { display: "59.00", currency: "USD" },
			createdAt: "2026-10-20T00:00:10Z",
		};
		const boundary = {
			createTicket: vi.fn(),
			query: vi.fn().mockResolvedValue({ data: { refundTickets: [ticket], refunds: [refund] } }),
		};
		const adapter = createWaffoAdminRefundAdapter(waffoEnvironment, boundary);
		expect((await adapter.inspect(waffoPayment, waffoRequest)).status).toBe("SUCCEEDED");
		boundary.query.mockResolvedValue({
			data: { refundTickets: [ticket], refunds: [{ ...refund, testMode: false }] },
		});
		await expect(adapter.inspect(waffoPayment, waffoRequest)).rejects.toThrow(
			"WAFFO_REFUND_BINDING_MISMATCH",
		);
		expect(boundary.createTicket).not.toHaveBeenCalled();
	});
	it("checks authoritative payment/store/order/previous refunds before claiming money", async () => {
		const remote = {
			id: payment.providerPaymentId,
			orderId: payment.providerOrderId,
			status: "succeeded",
			testMode: true,
			amount: { display: "59.00", currency: "USD" },
			refundedAmount: { display: "0.00", currency: "USD" },
			onetimeOrder: {
				id: payment.providerOrderId,
				storeId: "OTHER-STORE",
				testMode: true,
				orderMerchantExternalId: payment.checkoutIntentId,
			},
		};
		const boundary = {
			createTicket: vi.fn(),
			query: vi.fn().mockResolvedValue({ data: { payments: [remote] } }),
		};
		await expect(
			createWaffoAdminRefundAdapter(waffoEnvironment, boundary).verifyPayment(waffoPayment),
		).rejects.toThrow("WAFFO_REFUND_PAYMENT_MISMATCH");
		expect(boundary.createTicket).not.toHaveBeenCalled();
	});
	it("signs the merchant endpoint with a stable idempotency header without a customer bearer token", async () => {
		const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
		const fetchImplementation = vi
			.fn()
			.mockResolvedValue({ status: 200, json: async () => ({ data: { ticket } }) });
		const boundary = createWaffoAdminRefundBoundary(
			{
				...waffoEnvironment,
				WAFFO_MERCHANT_ID: "MER_0123456789AbCdEfGhIjKl",
				WAFFO_PRIVATE_KEY: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
				WAFFO_WEBHOOK_PUBLIC_KEY: publicKey.export({ format: "pem", type: "spki" }).toString(),
			},
			fetchImplementation,
		);
		await boundary.createTicket({
			paymentId: payment.providerPaymentId,
			reason: "Requested",
			requestedAmount: { amount: "59.00", currency: "USD" },
			refundTicketMerchantExternalId: request.providerRequestId,
		});
		const [url, init] = fetchImplementation.mock.calls[0]!;
		expect(url).toBe("https://api.waffo.ai/v1/actions/refund-ticket/create-ticket");
		expect(init.redirect).toBe("manual");
		expect(init.headers.Authorization).toBeUndefined();
		expect(init.headers["X-Idempotency-Key"]).toBe(request.providerRequestId);
		const hash = createHash("sha256").update(init.body).digest("base64");
		const verifier = createVerify("sha256");
		verifier.update(
			`POST\n/v1/actions/refund-ticket/create-ticket\n${init.headers["X-Timestamp"]}\n${hash}`,
		);
		expect(verifier.verify(publicKey, init.headers["X-Signature"], "base64")).toBe(true);
	});
	it.each([301, 302, 303, 307, 308])(
		"keeps HTTP %s as unknown without following the signed refund request",
		async (status) => {
			const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
			const fetchImplementation = vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ data: { ticket } }), {
					status,
					headers: { Location: "https://redirect.invalid/refund" },
				}),
			);
			const boundary = createWaffoAdminRefundBoundary(
				{
					...waffoEnvironment,
					WAFFO_MERCHANT_ID: "MER_0123456789AbCdEfGhIjKl",
					WAFFO_PRIVATE_KEY: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
					WAFFO_WEBHOOK_PUBLIC_KEY: publicKey.export({ format: "pem", type: "spki" }).toString(),
				},
				fetchImplementation,
			);
			const query = vi.fn();
			boundary.query = query;
			const adapter = createWaffoAdminRefundAdapter(waffoEnvironment, boundary);
			expect(await adapter.submit(waffoPayment, waffoRequest)).toEqual({
				status: "UNKNOWN",
				error: "WAFFO_REFUND_SUBMISSION_UNCONFIRMED",
			});
			expect(fetchImplementation).toHaveBeenCalledTimes(1);
			expect(fetchImplementation).toHaveBeenCalledWith(
				"https://api.waffo.ai/v1/actions/refund-ticket/create-ticket",
				expect.objectContaining({ method: "POST", redirect: "manual" }),
			);
			expect(query).not.toHaveBeenCalled();
			query.mockResolvedValue({ data: { refundTickets: [ticket], refunds: [] } });
			expect(await adapter.inspect(waffoPayment, waffoRequest)).toEqual({ status: "PROCESSING" });
			expect(fetchImplementation).toHaveBeenCalledTimes(1);
		},
	);
});

describe("historical Stripe admin refunds", () => {
	it("uses server minor units and the stable request key, and recovers by metadata without creation", async () => {
		const refund = {
			id: "re_1",
			charge: "ch_1",
			currency: "usd",
			amount: 5900,
			status: "succeeded",
			created: 1792454410,
			metadata: { admin_refund_request: request.providerRequestId },
		};
		const stripe = {
			charges: { retrieve: vi.fn() },
			refunds: {
				create: vi.fn().mockResolvedValue(refund),
				retrieve: vi.fn(),
				list: vi.fn().mockResolvedValue({ data: [refund], has_more: false }),
			},
		};
		const adapter = createStripeAdminRefundAdapter(stripe as never);
		const original = { ...payment, provider: "stripe", providerChargeId: "ch_1" };
		const originalRequest = { ...request, provider: "stripe" };
		expect((await adapter.submit(original, originalRequest)).status).toBe("SUCCEEDED");
		expect(stripe.refunds.create).toHaveBeenCalledWith(
			expect.objectContaining({ amount: 5900, charge: "ch_1" }),
			{ idempotencyKey: request.providerRequestId },
		);
		expect((await adapter.inspect(original, originalRequest)).status).toBe("SUCCEEDED");
		expect(stripe.refunds.create).toHaveBeenCalledTimes(1);
	});
});
