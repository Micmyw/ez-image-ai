import deSaas from "@repo/i18n/translations/de/saas.json";
import de from "@repo/i18n/translations/de/shared.json";
import enSaas from "@repo/i18n/translations/en/saas.json";
import en from "@repo/i18n/translations/en/shared.json";
import { NextIntlClientProvider } from "next-intl";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SubscriptionCheckoutNotice } from "./SubscriptionCheckoutNotice";

describe("subscription checkout explanations", () => {
	it.each(["paypal", "waffo"])(
		"explains every blocking state with the original %s payment method",
		(provider) => {
			const render = (cancellation: "PENDING" | "RETRYING" | "CONFIRMED" | null) =>
				renderToStaticMarkup(
					<NextIntlClientProvider locale="en" timeZone="UTC" messages={{ ...en, ...enSaas }}>
						<SubscriptionCheckoutNotice
							blockers={[
								{
									provider,
									subscription: {
										cancellation,
										cancelAtPeriodEnd: !!cancellation,
										currentPeriodEnd: new Date("2026-10-12T00:00:00Z"),
									},
								},
							]}
						/>
					</NextIntlClientProvider>,
				);
			expect(render(null)).toContain("may still renew");
			expect(render("PENDING")).toContain("awaiting confirmation");
			expect(render("RETRYING")).toContain("even after the local end date");
			const confirmed = render("CONFIRMED");
			expect(confirmed).toContain("confirmed canceled");
			expect(confirmed).toContain("Oct 12, 2026");
			expect(confirmed).toContain(provider === "paypal" ? "PayPal" : "Waffo");
		},
	);
	it("renders the translated confirmation and date in German", () => {
		const html = renderToStaticMarkup(
			<NextIntlClientProvider locale="de" timeZone="UTC" messages={{ ...de, ...deSaas }}>
				<SubscriptionCheckoutNotice
					blockers={[
						{
							provider: "waffo",
							subscription: {
								cancellation: "CONFIRMED",
								cancelAtPeriodEnd: true,
								currentPeriodEnd: new Date("2026-10-12T00:00:00Z"),
							},
						},
					]}
				/>
			</NextIntlClientProvider>,
		);
		expect(html).toContain("nachweislich gekündigt");
		expect(html).toContain("12.10.2026");
		expect(html).toContain("Waffo");
	});
});
