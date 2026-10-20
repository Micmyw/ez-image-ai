import { describe, expect, it, vi } from "vitest";

vi.mock("../client", () => ({ db: {} }));

import { getPaymentBotData, type PaymentBotReference } from "./admin-bots";

const reference: PaymentBotReference = {
	paymentEventId: "verified-event",
	provider: "paypal",
	kind: "subscription",
	providerPaymentId: "SALE-1",
	providerSubscriptionId: "I-1",
};
const event = {
	provider: "paypal",
	providerEnvironment: "sandbox",
	verifiedAt: new Date("2026-10-20T00:01:00Z"),
	status: "PROCESSED",
	envelope: {
		event_type: "PAYMENT.SALE.COMPLETED",
		create_time: "2026-10-20T00:02:00Z",
		resource: {
			id: "SALE-1",
			billing_agreement_id: "I-1",
			create_time: "2026-10-20T00:00:00Z",
			amount: { total: "19.00", currency: "USD" },
		},
	},
};
const registration = { utmSource: "registration-source", country: "CA" };
const user = {
	name: "Buyer",
	email: "buyer@example.test",
	createdAt: new Date("2026-10-01T00:00:00Z"),
	registrationAttribution: registration,
};
const initialPaymentEvidence = {
	version: 1,
	checkoutIntentId: "original-checkout",
	periodStart: "2026-10-20T00:00:00.000Z",
	periodEnd: "2027-10-20T00:00:00.000Z",
	providerPaymentId: "SALE-1",
};
function billingPeriodsFixture(year = 2026) {
	return Array.from({ length: 12 }, (_, index) => ({
		providerInvoiceId: null,
		providerInvoicePaymentId: "paypal:SALE-1",
		providerChargeId: null,
		paidAmount: 19_000_000n,
		startsAt: new Date(Date.UTC(year, 9 + index, 20)),
	}));
}
function clientFixture() {
	return {
		paymentEvent: { findUnique: vi.fn().mockResolvedValue(structuredClone(event)) },
		creditPackFulfillment: { findUnique: vi.fn().mockResolvedValue(null) },
		imagePassGrant: { findUnique: vi.fn().mockResolvedValue(null) },
		subscription: {
			findUnique: vi.fn().mockResolvedValue({
				id: "subscription-1",
				ownerType: "USER",
				ownerId: "buyer-1",
				plan: { name: "Annual plan" },
				purchase: { attribution: { utmSource: "purchase-source" } },
				initialPaymentEvidence: structuredClone(initialPaymentEvidence),
			}),
		},
		billingPeriod: {
			findMany: vi.fn().mockResolvedValue(billingPeriodsFixture()),
		},
		paymentCheckoutIntent: {
			findFirst: vi.fn().mockResolvedValue({
				submittedByUserId: "buyer-1",
				attribution: { utmSource: "checkout-source" },
			}),
		},
		user: { findUnique: vi.fn().mockResolvedValue(structuredClone(user)) },
	};
}

describe("committed administrator payment notification facts", () => {
	it.each([
		null,
		{ ...event, status: "RECEIVED" },
		{ ...event, verifiedAt: null },
		{ ...event, provider: "waffo" },
	])("requires the same provider and a verified processed event", async (receipt) => {
		const client = clientFixture();
		client.paymentEvent.findUnique.mockResolvedValue(receipt);
		expect(await getPaymentBotData(reference, client as never)).toBeNull();
		expect(client.subscription.findUnique).not.toHaveBeenCalled();
		expect(client.user.findUnique).not.toHaveBeenCalled();
	});

	it("reads one-time money from the committed fulfillment and preserves registration facts", async () => {
		const client = clientFixture();
		client.creditPackFulfillment.findUnique.mockResolvedValue({
			id: "pack-fulfillment",
			paidAmountMicros: 7_250_000n,
			currency: "USD",
			paidAt: new Date("2026-10-19T23:59:30Z"),
			checkoutIntent: {
				submittedByUserId: "buyer-1",
				planKey: "credits-pack",
				attribution: { utmSource: "checkout-source" },
			},
		});
		expect(
			await getPaymentBotData({ ...reference, kind: "one-time" }, client as never),
		).toMatchObject({
			eventKey: "payment:paypal:sandbox:SALE-1",
			orderId: "pack-fulfillment",
			amountMicros: "7250000",
			currency: "USD",
			paidAt: "2026-10-19T23:59:30.000Z",
			chargeType: "one-time",
			user: { registrationAttribution: registration },
		});
		expect(client.user.findUnique).toHaveBeenCalledWith({
			where: { id: "buyer-1" },
			select: { name: true, email: true, createdAt: true, registrationAttribution: true },
		});
	});

	it.each([false, true])("rejects absent or ambiguous one-time fulfillment: %s", async (both) => {
		const client = clientFixture();
		if (both) {
			client.creditPackFulfillment.findUnique.mockResolvedValue({ id: "pack" });
			client.imagePassGrant.findUnique.mockResolvedValue({ id: "pass" });
		}
		expect(await getPaymentBotData({ ...reference, kind: "one-time" }, client as never)).toBeNull();
		expect(client.user.findUnique).not.toHaveBeenCalled();
	});

	it.each([
		{ marker: initialPaymentEvidence, chargeType: "first", renewal: false },
		{
			marker: { ...initialPaymentEvidence, providerPaymentId: "OLDER-SALE" },
			chargeType: "renewal",
			renewal: true,
		},
		{ marker: null, chargeType: "subscription", renewal: false },
	])(
		"groups annual projections as one payment and labels $chargeType from evidence",
		async ({ marker, chargeType, renewal }) => {
			const client = clientFixture();
			client.subscription.findUnique.mockResolvedValue({
				id: "subscription-1",
				ownerType: "USER",
				ownerId: "buyer-1",
				plan: { name: "Annual plan" },
				purchase: { attribution: { utmSource: "purchase-source" } },
				initialPaymentEvidence: marker,
			});
			if (renewal) {
				client.billingPeriod.findMany.mockResolvedValue(billingPeriodsFixture(2027));
			}
			const result = await getPaymentBotData(reference, client as never);
			expect(result).toMatchObject({
				eventKey: "payment:paypal:sandbox:SALE-1",
				orderId: "subscription-1",
				amountMicros: "19000000",
				currency: "USD",
				paidAt: "2026-10-20T00:00:00.000Z",
				chargeType,
				user: { registrationAttribution: registration },
			});
			expect(client.billingPeriod.findMany).toHaveBeenCalledWith(
				expect.objectContaining({
					where: { subscriptionId: "subscription-1", providerInvoicePaymentId: "paypal:SALE-1" },
				}),
			);
			if (marker)
				expect(client.paymentCheckoutIntent.findFirst).toHaveBeenCalledWith(
					expect.objectContaining({
						where: {
							provider: "paypal",
							ownerType: "USER",
							ownerId: "buyer-1",
							id: "original-checkout",
						},
					}),
				);
		},
	);

	it("does not fabricate a receipt when the provider evidence belongs to another subscription", async () => {
		const client = clientFixture();
		client.paymentEvent.findUnique.mockResolvedValue({
			...event,
			envelope: {
				...event.envelope,
				resource: { ...event.envelope.resource, billing_agreement_id: "I-OTHER" },
			},
		});
		expect(await getPaymentBotData(reference, client as never)).toBeNull();
		expect(client.paymentCheckoutIntent.findFirst).not.toHaveBeenCalled();
		expect(client.user.findUnique).not.toHaveBeenCalled();
	});
});
