import { NextIntlClientProvider } from "next-intl";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const availability = vi.hoisted(() => ({
	data: { available: true } as { available: boolean } | undefined,
	isError: false,
	isPending: false,
}));
vi.mock("@tanstack/react-query", async (original) => ({
	...(await original<typeof import("@tanstack/react-query")>()),
	useQuery: () => availability,
}));

import de from "../../../../../packages/i18n/translations/de/saas.json";
import en from "../../../../../packages/i18n/translations/en/saas.json";
import es from "../../../../../packages/i18n/translations/es/saas.json";
import fr from "../../../../../packages/i18n/translations/fr/saas.json";
import { ImagePassBanner } from "./ImagePassBanner";

describe("image pass offer banner", () => {
	beforeEach(() => {
		availability.data = { available: true };
		availability.isError = false;
		availability.isPending = false;
	});
	it.each(["unavailable", "loading", "error"])(
		"hides checkout advertising when server availability is %s",
		(mode) => {
			availability.data = mode === "loading" ? undefined : { available: mode === "error" };
			availability.isError = mode === "error";
			availability.isPending = mode === "loading";
			expect(
				renderToStaticMarkup(
					<NextIntlClientProvider locale="en" messages={en}>
						<ImagePassBanner />
					</NextIntlClientProvider>,
				),
			).toBe("");
		},
	);
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
