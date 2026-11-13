import { getVideoTemplate } from "@repo/config/video-template-library";
import { describe, expect, it } from "vitest";

import de from "../../../../../packages/i18n/translations/de/marketing.json";
import en from "../../../../../packages/i18n/translations/en/marketing.json";
import es from "../../../../../packages/i18n/translations/es/marketing.json";
import fr from "../../../../../packages/i18n/translations/fr/marketing.json";
import { canAutoShowHomepageShowcase, HOMEPAGE_SHOWCASE_KEYS } from "./homepage-showcase";

describe("homepage showcase", () => {
	it.each(["", "?lang=de", "?utm_source=newsletter&lang=fr"])(
		"invites a new homepage visitor (%s)",
		(query) => {
			expect(canAutoShowHomepageShowcase(query, "")).toBe(true);
		},
	);
	it.each([
		"?job=abc",
		"?videoJob=abc",
		"?mode=video",
		"?example=birthday-card",
		"?checkout=return",
		"?asset=photo",
	])("leaves direct work links uninterrupted (%s)", (query) => {
		expect(canAutoShowHomepageShowcase(query, "")).toBe(false);
	});
	it("leaves deep links uninterrupted", () => {
		expect(canAutoShowHomepageShowcase("", "#image-editor")).toBe(false);
	});
	it("keeps three photo ideas ahead of one landscape video", () => {
		expect(HOMEPAGE_SHOWCASE_KEYS).toEqual([
			"watercolor",
			"vintage-photo",
			"christmas",
			"green-booth-freestyle",
		]);
		const template = getVideoTemplate("green-booth-freestyle");
		expect(template?.sample?.video).toMatch(/^https:\/\//);
		expect(template?.canonicalPath).toBe("/video-templates/green-booth-freestyle");
	});
	it.each([de, es, fr])("has complete translated preview controls and descriptions", (messages) => {
		const expected = en.home.showcasePopup;
		const actual = messages.home.showcasePopup;
		expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
		expect(Object.keys(actual.items).sort()).toEqual([...HOMEPAGE_SHOWCASE_KEYS].sort());
		for (const item of Object.values(actual.items)) {
			expect(item.title.length).toBeGreaterThan(0);
			expect(item.description.length).toBeGreaterThan(0);
		}
	});
});
