import { growthAnalyticsEventSchema } from "@repo/utils/lib/growth-analytics";
import { createTranslator } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import de from "../../../../../packages/i18n/translations/de/marketing.json";
import en from "../../../../../packages/i18n/translations/en/marketing.json";
import es from "../../../../../packages/i18n/translations/es/marketing.json";
import fr from "../../../../../packages/i18n/translations/fr/marketing.json";

const state = vi.hoisted(() => ({ example: "", locale: "en" as "en" | "de" | "es" | "fr" }));
const translations = { en, de, es, fr };
vi.mock("next/navigation", () => ({
	useSearchParams: () => new URLSearchParams({ example: state.example }),
}));
vi.mock("next-intl", async (original) => ({
	...(await original<typeof import("next-intl")>()),
	useTranslations: (namespace: "home.showcase" | "home.quickStartPrompts") =>
		createTranslator({ locale: state.locale, messages: translations[state.locale], namespace }),
}));
import { useShowcasePrompt } from "./use-showcase-prompt";

describe("quick-start preset URLs", () => {
	it.each(["en", "de", "es", "fr"] as const)(
		"resolves localized image presets and existing examples in %s",
		(locale) => {
			state.locale = locale;
			state.example = "restore-photo";
			expect(useShowcasePrompt()).toBe(translations[locale].home.quickStartPrompts.restorePhoto);
			state.example = "birthday-card";
			expect(useShowcasePrompt()).toBe(translations[locale].home.quickStartPrompts.birthdayCard);
			state.example = "birthdayPortrait";
			expect(useShowcasePrompt()).toBe(translations[locale].home.quickStartPrompts.birthdayCard);
			state.example = "watercolor";
			expect(useShowcasePrompt()).toBe(translations[locale].home.quickStartPrompts.watercolor);
			state.example = "vintage-photo";
			expect(useShowcasePrompt()).toBe(translations[locale].home.quickStartPrompts.vintagePhoto);
			state.example = "mediterranean";
			expect(useShowcasePrompt()).toBe(
				translations[locale].home.showcase.items.mediterranean.prompt,
			);
		},
	);
	it.each(["unknown", "__proto__", "constructor", ""])(
		"leaves unrecognized preset %s empty",
		(example) => {
			state.example = example;
			expect(useShowcasePrompt()).toBe("");
		},
	);
	it("accepts bounded idea click measurements without photo or prompt payloads", () => {
		for (const homepageIdea of [
			"sheru-bhai",
			"christmas",
			"restore-photo",
			"birthday-card",
			"kung-fu-cat",
		]) {
			expect(
				growthAnalyticsEventSchema.safeParse({
					name: "homepage_idea_selected",
					properties: { homepageIdea, status: "selected" },
				}).success,
			).toBe(true);
		}
		expect(
			growthAnalyticsEventSchema.safeParse({
				name: "homepage_idea_selected",
				properties: { homepageIdea: "private photo text" },
			}).success,
		).toBe(false);
	});
});
