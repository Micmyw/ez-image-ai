import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import de from "../../../../../../packages/i18n/translations/de/saas.json";
import en from "../../../../../../packages/i18n/translations/en/saas.json";
import es from "../../../../../../packages/i18n/translations/es/saas.json";
import fr from "../../../../../../packages/i18n/translations/fr/saas.json";
import { PaymentAttributionRecords } from "./PaymentAttributionPanel";

const attributed = {
	id: "subscription-order",
	ownerType: "USER" as const,
	ownerId: "user-1",
	type: "SUBSCRIPTION" as const,
	productKind: "PLAN" as const,
	provider: "stripe",
	status: "active",
	createdAt: "2026-10-08T12:00:00Z",
	attribution: {
		version: 1 as const,
		registration: {
			version: 1 as const,
			landingPath: "/blog/photo-ideas",
			referrerOrigin: "https://search.example.test",
			source: "campaign" as const,
			utmSource: "search",
			utmMedium: "organic",
			utmCampaign: "autumn",
			capturedAt: "2026-10-01T12:00:00Z",
			registeredAt: "2026-10-02T12:00:00Z",
		},
		triggerPath: "/photo-to-coloring-page",
		triggeredAt: "2026-10-08T11:59:00Z",
	},
};

describe("order attribution display", () => {
	it.each([
		["en", en],
		["de", de],
	] as const)(
		"renders distinct registration and checkout pages with historical unknowns in %s",
		(locale, messages) => {
			const labels = messages.admin.media.paymentAttribution;
			const markup = renderToStaticMarkup(
				<NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
					<PaymentAttributionRecords
						purchases={[attributed]}
						checkouts={[
							{
								...attributed,
								id: "historical-checkout",
								type: undefined,
								productKind: "CREDIT_PACK",
								attribution: null,
							},
						]}
					/>
				</NextIntlClientProvider>,
			);
			for (const value of [
				labels.registrationSource,
				labels.triggerPath,
				labels.renewalHint,
				labels.unknown,
				"/blog/photo-ideas",
				"/photo-to-coloring-page",
				"https://search.example.test",
				"search / organic / autumn",
				"historical-checkout",
			])
				expect(markup).toContain(value);
			expect(markup).not.toContain("href=");
		},
	);
	it("keeps all four locale keys aligned", () => {
		const keys = (value: unknown, prefix = ""): string[] =>
			Object.entries(value as Record<string, unknown>)
				.flatMap(([key, child]) =>
					typeof child === "string" ? [`${prefix}${key}`] : keys(child, `${prefix}${key}.`),
				)
				.sort();
		for (const messages of [de, es, fr])
			expect(keys(messages.admin.media.paymentAttribution)).toEqual(
				keys(en.admin.media.paymentAttribution),
			);
	});
});
