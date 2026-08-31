import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) =>
		({
			label: "Payment method",
			"providers.stripe": "Credit or debit card",
			"providers.paypal": "PayPal",
			"providers.waffo": "Waffo",
		})[key] ?? key,
}));

import { PaymentProviderSelector } from "./PaymentProviderSelector";

describe("PaymentProviderSelector", () => {
	it("renders native, labelled radio controls for available providers", () => {
		const markup = renderToStaticMarkup(
			<PaymentProviderSelector
				name="creator-month-provider"
				providers={["stripe", "paypal", "waffo"]}
				value="paypal"
				onValueChange={vi.fn()}
			/>,
		);

		expect(markup).toContain("<fieldset");
		expect(markup).toContain("<legend");
		expect(markup).toContain("Payment method");
		expect(markup).toContain('type="radio"');
		expect(markup).toContain('name="creator-month-provider"');
		expect(markup).toMatch(/checked="" value="paypal"/);
		expect(markup).toContain("Credit or debit card");
		expect(markup).toContain("PayPal");
		expect(markup).toContain("Waffo");
	});
});
