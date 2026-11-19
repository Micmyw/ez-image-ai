import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { getVideoTemplate } from "@repo/config/video-template-library";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import de from "../../../../../packages/i18n/translations/de/marketing.json";
import en from "../../../../../packages/i18n/translations/en/marketing.json";
import es from "../../../../../packages/i18n/translations/es/marketing.json";
import fr from "../../../../../packages/i18n/translations/fr/marketing.json";
import {
	canAutoShowHomepageShowcase,
	HOMEPAGE_SHOWCASE_COMPACT_COMPARISON,
	HOMEPAGE_SHOWCASE_KEYS,
	HOMEPAGE_SHOWCASE_MEDIA,
} from "./homepage-showcase";

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
		"?lang=de&utm_source=newsletter&reuseJob=abc",
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
	it.each([
		{
			stage: "desktop",
			width: 960,
			maximumKiB: 150,
			pair: HOMEPAGE_SHOWCASE_MEDIA[HOMEPAGE_SHOWCASE_KEYS[0]],
		},
		{ stage: "mobile", width: 768, maximumKiB: 100, pair: HOMEPAGE_SHOWCASE_COMPACT_COMPARISON },
	])(
		"ships a lightweight versioned comparison pair for $stage",
		async ({ width, maximumKiB, pair }) => {
			let totalBytes = 0;
			for (const src of [pair.before, pair.poster]) {
				const image = await readFile(new URL(`../../../public${src}`, import.meta.url));
				totalBytes += image.length;
				expect(await sharp(image).metadata()).toMatchObject({
					format: "webp",
					width,
					height: (width * 9) / 16,
				});
				const hash = createHash("sha256").update(image).digest("hex").slice(0, 16);
				expect(src).toMatch(`.${hash}.webp`);
			}
			expect(totalBytes).toBeLessThan(maximumKiB * 1024);
		},
	);
	it.each(HOMEPAGE_SHOWCASE_KEYS)(
		"ships a small versioned WebP for the %s picker button",
		async (key) => {
			const { thumbnail } = HOMEPAGE_SHOWCASE_MEDIA[key];
			const image = await readFile(new URL(`../../../public${thumbnail}`, import.meta.url));
			expect(image.length).toBeLessThan(8 * 1024);
			expect(await sharp(image).metadata()).toMatchObject({
				format: "webp",
				width: 144,
				height: 102,
			});
			const hash = createHash("sha256").update(image).digest("hex").slice(0, 16);
			expect(thumbnail).toBe(`/images/landing/variants/showcase-${key}-144.${hash}.webp`);
		},
	);
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
