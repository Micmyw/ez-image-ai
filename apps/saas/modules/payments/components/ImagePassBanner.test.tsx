import { NextIntlClientProvider } from "next-intl";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import de from "../../../../../packages/i18n/translations/de/saas.json";
import en from "../../../../../packages/i18n/translations/en/saas.json";
import es from "../../../../../packages/i18n/translations/es/saas.json";
import fr from "../../../../../packages/i18n/translations/fr/saas.json";
import { ImagePassBanner } from "./ImagePassBanner";

describe("image pass offer banner", () => {
	it.each(Object.entries({ en, de, es, fr }))(
		"renders the one-time USD offer in %s without changing it into credits",
		(locale, messages) => {
			const markup = renderToStaticMarkup(
				<NextIntlClientProvider locale={locale} messages={messages}>
					<ImagePassBanner registered />
				</NextIntlClientProvider>,
			);
			expect(markup).toContain("USD 1.00");
			expect(markup).toContain("4K");
			expect(markup).toContain('href="/image-pass"');
			expect(markup).not.toContain("25 credits");
			expect(markup).not.toContain("75 credits");
		},
	);
	it("keeps the offer destination through registration", () => {
		const markup = renderToStaticMarkup(
			<NextIntlClientProvider locale="en" messages={en}>
				<ImagePassBanner />
			</NextIntlClientProvider>,
		);
		expect(markup).toContain("/signup?redirectTo=%2Fimage-pass");
	});
});
