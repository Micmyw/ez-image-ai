import { IMAGE_PASS_PAYPAL_SKU, IMAGE_PASS_AMOUNT_MICROS } from "@repo/config/image-pass.server";
import { describe, it, expect, vi } from "vitest";

import {
	capturePayPalCheckoutOrder,
	createPayPalCheckoutLink,
	type PayPalHttpBoundary,
} from "./paypal";
const configuration = {
	accessToken: "synthetic-token",
	baseUrl: "https://api-m.sandbox.paypal.com",
};
const capture = {
	id: "CAPTURE-1",
	status: "COMPLETED",
	final_capture: true,
	create_time: "2026-10-19T12:00:00Z",
	amount: { value: "1.00", currency_code: "USD" },
};
const completed = {
	id: "ORDER-1",
	status: "COMPLETED",
	purchase_units: [{ custom_id: "intent-1", payments: { captures: [capture] } }],
};
describe("image-pass PayPal order boundary", () => {
	it("sends the exact USD one-dollar merchant SKU and bound intent to PayPal", async () => {
		const request = vi.fn<PayPalHttpBoundary["request"]>().mockResolvedValue({
			status: 201,
			body: {
				id: "ORDER-1",
				create_time: "2026-10-19T12:00:00Z",
				links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/order" }],
			},
		});
		await createPayPalCheckoutLink({ request }, configuration, {
			type: "one-time",
			priceId: IMAGE_PASS_PAYPAL_SKU,
			currency: "USD",
			amountMicros: IMAGE_PASS_AMOUNT_MICROS,
			description: "3 successful images",
			billingPlanId: "plan-1",
			checkoutIntentId: "intent-1",
			idempotencyKey: "attempt-1",
			planKey: "image-pass-3",
			ownerType: "USER",
			ownerId: "buyer",
			submittedByUserId: "buyer",
			redirectUrl: "https://app.test/image-pass-checkout-return?intentId=intent-1",
		});
		expect(request).toHaveBeenCalledWith(
			expect.objectContaining({
				body: expect.objectContaining({
					intent: "CAPTURE",
					purchase_units: [
						expect.objectContaining({
							custom_id: "intent-1",
							reference_id: "image-pass-3",
							amount: expect.objectContaining({ value: "1.00", currency_code: "USD" }),
							items: [
								expect.objectContaining({
									sku: IMAGE_PASS_PAYPAL_SKU,
									quantity: "1",
									unit_amount: { value: "1.00", currency_code: "USD" },
								}),
							],
						}),
					],
				}),
			}),
		);
	});
	it("recovers an already-captured return by retrieving only the same authenticated order", async () => {
		const request = vi
			.fn<PayPalHttpBoundary["request"]>()
			.mockResolvedValueOnce({
				status: 422,
				body: { details: [{ issue: "ORDER_ALREADY_CAPTURED" }] },
			})
			.mockResolvedValueOnce({ status: 200, body: completed });
		await expect(
			capturePayPalCheckoutOrder({ request }, configuration, {
				providerOrderId: "ORDER-1",
				idempotencyKey: "stable-key",
			}),
		).resolves.toMatchObject({
			normalizedTransactionId: "CAPTURE-1",
			envelope: {
				resource: { custom_id: "intent-1", amount: { value: "1.00", currency_code: "USD" } },
			},
		});
		expect(request).toHaveBeenNthCalledWith(2, {
			method: "GET",
			url: "https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER-1",
			headers: { Authorization: "Bearer synthetic-token" },
		});
	});
	it.each([
		{ ...completed, id: "ORDER-OTHER" },
		{ ...completed, status: "APPROVED" },
		{ ...completed, purchase_units: [] },
		{
			...completed,
			purchase_units: [{ custom_id: "intent-1", payments: { captures: [capture, capture] } }],
		},
	])("refuses ambiguous recovery representations %s", async (body) => {
		const request = vi
			.fn<PayPalHttpBoundary["request"]>()
			.mockResolvedValueOnce({
				status: 422,
				body: { details: [{ issue: "ORDER_ALREADY_CAPTURED" }] },
			})
			.mockResolvedValueOnce({ status: 200, body });
		await expect(
			capturePayPalCheckoutOrder({ request }, configuration, {
				providerOrderId: "ORDER-1",
				idempotencyKey: "stable-key",
			}),
		).rejects.toThrow("PAYPAL_CAPTURE_RESPONSE_INVALID");
	});
	it("does not turn a generic capture failure into another order or a guessed success", async () => {
		const request = vi
			.fn<PayPalHttpBoundary["request"]>()
			.mockResolvedValue({ status: 422, body: { details: [{ issue: "OTHER_FAILURE" }] } });
		await expect(
			capturePayPalCheckoutOrder({ request }, configuration, {
				providerOrderId: "ORDER-1",
				idempotencyKey: "stable-key",
			}),
		).rejects.toThrow("PAYPAL_CAPTURE_RESPONSE_INVALID");
		expect(request).toHaveBeenCalledTimes(1);
	});
});
