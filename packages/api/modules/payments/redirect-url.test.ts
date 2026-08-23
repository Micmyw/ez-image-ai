import { getBaseUrl } from "@repo/utils";
import { describe, expect, it } from "vitest";

import { paymentRedirectUrlSchema } from "./redirect-url";

describe("paymentRedirectUrlSchema", () => {
	it("accepts redirects on the SaaS application origin", () => {
		const applicationUrl = new URL(getBaseUrl(process.env.NEXT_PUBLIC_SAAS_URL, 3000));
		applicationUrl.pathname = "/checkout-return";
		applicationUrl.searchParams.set("organizationId", "organization-1");

		const result = paymentRedirectUrlSchema.safeParse(applicationUrl.toString());

		expect(result.success).toBe(true);
	});

	it.each([
		"https://attacker.example/checkout-return",
		"http://localhost:3000.attacker.example/checkout-return",
		"javascript:alert('redirected')",
		"//attacker.example/checkout-return",
	])("rejects an unsafe redirect URL: %s", (redirectUrl) => {
		const result = paymentRedirectUrlSchema.safeParse(redirectUrl);

		expect(result.success).toBe(false);
	});

	it("allows the redirect URL to be omitted", () => {
		const result = paymentRedirectUrlSchema.safeParse(undefined);

		expect(result.success).toBe(true);
	});
});
