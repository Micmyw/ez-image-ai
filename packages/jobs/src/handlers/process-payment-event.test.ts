import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	createStripeBillingSource,
	db,
	getStripeClient,
	processProviderPaymentEvent,
	processStripePaymentEvent,
} = vi.hoisted(() => ({
	createStripeBillingSource: vi.fn(),
	db: { paymentEvent: { findUnique: vi.fn() } },
	getStripeClient: vi.fn(),
	processProviderPaymentEvent: vi.fn(),
	processStripePaymentEvent: vi.fn(),
}));

vi.mock("@repo/database/client", () => ({ db }));
vi.mock("@repo/payments", () => ({
	createStripeBillingSource,
	getStripeClient,
	processProviderPaymentEvent,
	processStripePaymentEvent,
}));

import { processPaymentEvent } from "./process-payment-event";

const attempt = { attempt: 2, maxAttempts: 8, triggerRunId: "run_1" };

describe("processPaymentEvent", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps Stripe on its existing processor and billing source", async () => {
		const result = { outcome: "PROCESSED", grantsCreated: 1 };
		const stripe = { id: "stripe-client" };
		const billingSource = { id: "billing-source" };
		db.paymentEvent.findUnique.mockResolvedValue({ provider: "stripe" });
		getStripeClient.mockReturnValue(stripe);
		createStripeBillingSource.mockReturnValue(billingSource);
		processStripePaymentEvent.mockResolvedValue(result);

		await expect(processPaymentEvent({ paymentEventId: "event_1" }, attempt)).resolves.toBe(result);
		expect(processStripePaymentEvent).toHaveBeenCalledWith(
			{ paymentEventId: "event_1" },
			db,
			attempt,
			{ billingSource },
		);
		expect(processProviderPaymentEvent).not.toHaveBeenCalled();
	});

	it.each(["paypal", "waffo", "unknown", null])(
		"routes persisted provider %s through the provider-neutral processor",
		async (provider) => {
			const result = { outcome: "DEAD_LETTER", grantsCreated: 0 };
			db.paymentEvent.findUnique.mockResolvedValue(provider ? { provider } : null);
			processProviderPaymentEvent.mockResolvedValue(result);

			await expect(processPaymentEvent({ paymentEventId: "event_2" }, attempt)).resolves.toBe(
				result,
			);
			expect(processProviderPaymentEvent).toHaveBeenCalledWith(
				{ paymentEventId: "event_2" },
				db,
				attempt,
			);
			expect(getStripeClient).not.toHaveBeenCalled();
		},
	);
});
