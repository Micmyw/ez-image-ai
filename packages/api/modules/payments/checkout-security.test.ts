import { describe, expect, it } from "vitest";

import { checkoutInputSchema } from "./procedures/create-checkout-link";

const validInput = {
	provider: "paypal",
	planId: "creator",
	interval: "month",
	idempotencyKey: "checkout-operation-0001",
} as const;

describe("checkout security boundaries", () => {
	it("accepts only the stable provider and EzPic product selection", () => {
		expect(checkoutInputSchema.safeParse(validInput)).toMatchObject({ success: true });
	});

	it.each([
		["provider price", { providerPriceId: "P-ATTACKER-CONTROLLED" }],
		["redirect", { redirectUrl: "https://evil.example/checkout-return" }],
		["owner", { organizationId: "attacker-controlled-owner" }],
		["legacy purchase type", { type: "subscription" }],
	] as const)("rejects a client-controlled %s field", (_label, injected) => {
		expect(checkoutInputSchema.safeParse({ ...validInput, ...injected })).toMatchObject({
			success: false,
		});
	});

	it("rejects unknown providers and weak idempotency keys", () => {
		expect(checkoutInputSchema.safeParse({ ...validInput, provider: "unknown" })).toMatchObject({
			success: false,
		});
		expect(checkoutInputSchema.safeParse({ ...validInput, idempotencyKey: "short" })).toMatchObject(
			{
				success: false,
			},
		);
	});
});
