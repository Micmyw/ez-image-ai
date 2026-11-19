import { IMAGE_PASS_OFFER_SUMMARY } from "@repo/config/image-pass-summary";
import { NextIntlClientProvider } from "next-intl";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const availability = vi.hoisted(() => ({
	data: { available: true } as { available: boolean } | undefined,
	isError: false,
	isPending: false,
}));
const runtime = vi.hoisted(() => ({
	dismissed: false as boolean | null,
	readDismissal: () => {},
	useQuery: vi.fn(() => availability),
}));
vi.mock("@tanstack/react-query", async (original) => ({
	...(await original<typeof import("@tanstack/react-query")>()),
	useQuery: runtime.useQuery,
}));
vi.mock("react", async (original) => {
	const react = await original<typeof import("react")>();
	return {
		...react,
		useState: (initial: unknown) =>
			initial === null
				? [
						runtime.dismissed,
						(value: boolean) => {
							runtime.dismissed = value;
						},
					]
				: react.useState(initial),
		useEffect: (effect: () => void) => {
			runtime.readDismissal = effect;
		},
	};
});

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
		runtime.dismissed = false;
		runtime.useQuery.mockClear();
	});
	it("skips the offer query before browser storage is read and after a stored dismissal", () => {
		runtime.dismissed = null;
		const render = () =>
			renderToStaticMarkup(
				<NextIntlClientProvider locale="en" messages={en}>
					<ImagePassBanner />
				</NextIntlClientProvider>,
			);
		expect(render()).toMatch(/^<div[^>]*data-image-pass-slot=""><\/div>$/);
		expect(runtime.useQuery).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));

		const getItem = vi.fn(() => "1");
		vi.stubGlobal("window", { sessionStorage: { getItem } });
		try {
			runtime.readDismissal();
			expect(getItem).toHaveBeenCalledWith(
				`ezpic:image-pass-banner:${IMAGE_PASS_OFFER_SUMMARY.offerVersion}`,
			);
			expect(render()).toMatch(/^<div[^>]*data-image-pass-slot=""><\/div>$/);
			expect(runtime.useQuery).toHaveBeenLastCalledWith(
				expect.objectContaining({ enabled: false }),
			);
		} finally {
			vi.unstubAllGlobals();
		}
	});
	it("still checks the authoritative offer with the banner open", () => {
		const markup = renderToStaticMarkup(
			<NextIntlClientProvider locale="en" messages={en}>
				<ImagePassBanner />
			</NextIntlClientProvider>,
		);
		expect(markup).toContain('href="/image-pass"');
		expect(markup).not.toContain("/signup");
		expect(runtime.useQuery).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true }));
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
			).toMatch(/^<div[^>]*data-image-pass-slot=""><\/div>$/);
		},
	);
	it.each(Object.entries({ en, de, es, fr }))(
		"renders the one-time USD offer in %s without changing it into credits",
		(locale, messages) => {
			const { bannerLabel, bannerTitle, bannerDetail, dismissBanner, buy } = messages.imagePass;
			const markup = renderToStaticMarkup(
				<NextIntlClientProvider
					locale={locale}
					timeZone="UTC"
					messages={{ imagePass: { bannerLabel, bannerTitle, bannerDetail, dismissBanner, buy } }}
				>
					<ImagePassBanner />
				</NextIntlClientProvider>,
			);
			expect(markup).toContain("$2.99");
			expect(markup).not.toContain("USD");
			expect(markup).toContain("4K");
			expect(markup).toContain("GPT Image 2.6");
			expect(markup).toContain("SVG");
			expect(markup).toContain("GIF");
			expect(markup).toContain(bannerDetail);
			expect(markup).toContain('href="/image-pass"');
			expect(markup).toContain(`aria-label="${dismissBanner}"`);
			expect(markup).not.toContain("25 credits");
			expect(markup).not.toContain("75 credits");
		},
	);
	it("provides an accessible dismissal button beside the purchase link", () => {
		const markup = renderToStaticMarkup(
			<NextIntlClientProvider locale="en" messages={en}>
				<ImagePassBanner />
			</NextIntlClientProvider>,
		);
		expect(markup).toContain('aria-label="Dismiss image pack offer"');
		expect(markup).toContain('type="button"');
		expect(markup).toContain('href="/image-pass"');
	});
});
