import { describe, expect, it, vi } from "vitest";

import { createCheckoutAttemptController } from "./checkout-attempt";

const creatorMonthlyPayPal = {
	provider: "paypal" as const,
	planId: "creator" as const,
	interval: "month" as const,
};

describe("checkout attempt idempotency", () => {
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
