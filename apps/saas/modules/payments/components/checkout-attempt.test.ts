import { describe, expect, it, vi } from "vitest";

import * as checkoutAttempt from "./checkout-attempt";

const { createCheckoutAttemptController } = checkoutAttempt;

const creatorMonthlyPayPal = {
	provider: "paypal" as const,
	planId: "creator" as const,
	interval: "month" as const,
};

describe("checkout attempt idempotency", () => {
	it("keeps Stripe outside new subscription checkout choices", () => {
		expect(
			checkoutAttempt.filterSubscriptionCheckoutProviders(["stripe", "paypal", "waffo"]),
		).toEqual(["paypal", "waffo"]);
	});

	it("reuses the same key when the same failed command is retried", () => {
		const createKey = vi.fn().mockReturnValueOnce("attempt-1").mockReturnValueOnce("attempt-2");
		const attempts = createCheckoutAttemptController(createKey);

		expect(attempts.begin(creatorMonthlyPayPal)).toBe("attempt-1");
		expect(attempts.begin(creatorMonthlyPayPal)).toBe("attempt-1");
		expect(createKey).toHaveBeenCalledTimes(1);
	});

	it("rotates on every selection change and never resurrects an older key", () => {
		const createKey = vi
			.fn()
			.mockReturnValueOnce("attempt-1")
			.mockReturnValueOnce("attempt-2")
			.mockReturnValueOnce("attempt-3");
		const attempts = createCheckoutAttemptController(createKey);

		expect(attempts.begin(creatorMonthlyPayPal)).toBe("attempt-1");
		expect(attempts.begin({ ...creatorMonthlyPayPal, provider: "waffo" })).toBe("attempt-2");
		expect(attempts.begin(creatorMonthlyPayPal)).toBe("attempt-3");
	});

	it("invalidates a successful command so it cannot be replayed", () => {
		const createKey = vi.fn().mockReturnValueOnce("attempt-1").mockReturnValueOnce("attempt-2");
		const attempts = createCheckoutAttemptController(createKey);

		expect(attempts.begin(creatorMonthlyPayPal)).toBe("attempt-1");
		attempts.succeeded(creatorMonthlyPayPal);
		expect(attempts.begin(creatorMonthlyPayPal)).toBe("attempt-2");
	});
});

describe("credit pack checkout attempts", () => {
	it("keeps Stripe outside the one-time checkout choices", () => {
		const filterProviders = (
			checkoutAttempt as typeof checkoutAttempt & {
				filterCreditPackCheckoutProviders?: (providers: string[]) => string[];
			}
		).filterCreditPackCheckoutProviders;

		if (!filterProviders) {
			expect(filterProviders).toBeTypeOf("function");
			return;
		}

		expect(filterProviders(["stripe", "paypal", "waffo"])).toEqual(["paypal", "waffo"]);
	});

	it("reuses an idempotency key only for the same pack and provider", () => {
		const createController = (
			checkoutAttempt as typeof checkoutAttempt & {
				createCreditPackCheckoutAttemptController?: (createKey: () => string) => {
					begin: (selection: { packKey: string; provider: "paypal" | "waffo" }) => string;
					succeeded: (selection: { packKey: string; provider: "paypal" | "waffo" }) => void;
				};
			}
		).createCreditPackCheckoutAttemptController;

		if (!createController) {
			expect(createController).toBeTypeOf("function");
			return;
		}

		const createKey = vi
			.fn()
			.mockReturnValueOnce("pack-attempt-1")
			.mockReturnValueOnce("pack-attempt-2")
			.mockReturnValueOnce("pack-attempt-3");
		const attempts = createController(createKey);
		const selection = { packKey: "credits-1500", provider: "paypal" as const };

		expect(attempts.begin(selection)).toBe("pack-attempt-1");
		expect(attempts.begin(selection)).toBe("pack-attempt-1");
		expect(attempts.begin({ ...selection, provider: "waffo" })).toBe("pack-attempt-2");
		attempts.succeeded({ ...selection, provider: "waffo" });
		expect(attempts.begin({ ...selection, provider: "waffo" })).toBe("pack-attempt-3");
	});

	it("captures only a PayPal return that includes both immutable identifiers", () => {
		const getCaptureInput = (
			checkoutAttempt as typeof checkoutAttempt & {
				getPayPalCreditPackCaptureInput?: (
					intentId: string,
					providerOrderId?: string,
				) => { intentId: string; providerOrderId: string } | null;
			}
		).getPayPalCreditPackCaptureInput;

		if (!getCaptureInput) {
			expect(getCaptureInput).toBeTypeOf("function");
			return;
		}

		expect(getCaptureInput("intent-1", "paypal-order-1")).toEqual({
			intentId: "intent-1",
			providerOrderId: "paypal-order-1",
		});
		expect(getCaptureInput("intent-1")).toBeNull();
		expect(getCaptureInput("", "paypal-order-1")).toBeNull();
	});

	it("redirects only a completed grant to the editor", () => {
		const getDestination = (
			checkoutAttempt as typeof checkoutAttempt & {
				getCreditPackCheckoutDestination?: (
					status?: "PENDING" | "COMPLETED" | "REVIEW" | "EXPIRED" | "CANCELED",
				) => string | null;
			}
		).getCreditPackCheckoutDestination;

		if (!getDestination) {
			expect(getDestination).toBeTypeOf("function");
			return;
		}

		expect(getDestination("COMPLETED")).toBe("/create?credits=purchased");
		for (const status of [undefined, "PENDING", "REVIEW", "EXPIRED", "CANCELED"] as const) {
			expect(getDestination(status)).toBeNull();
		}
	});
});
