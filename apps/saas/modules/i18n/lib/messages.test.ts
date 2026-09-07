import { EZPIC_PRODUCT_KEYS, IMAGE_SKU_KEYS } from "@repo/config/client";
import { getUnifiedMessagesForLocale } from "@repo/i18n";
import { describe, expect, it } from "vitest";

describe("unified application messages", () => {
	it("loads SaaS and landing-page namespaces for the same locale", async () => {
		const messages = await getUnifiedMessagesForLocale("en");

		expect(messages.auth).toBeDefined();
		expect(messages.home.generator.offer).toBe("Try Nano Banana 2 Lite 1K free");
		expect(messages.common.menu.login).toBe("Sign In");
	});

	it.each(["en", "de", "es", "fr"] as const)(
		"keeps %s product and SKU labels aligned with the public catalog keys",
		async (locale) => {
			const messages = await getUnifiedMessagesForLocale(locale);

			expect(Object.keys(messages.media.create.products).sort()).toEqual(
				[...EZPIC_PRODUCT_KEYS].sort(),
			);
			expect(Object.keys(messages.media.create.skus).sort()).toEqual([...IMAGE_SKU_KEYS].sort());
		},
	);

	it.each(["en", "de", "es", "fr"] as const)(
		"keeps %s edit-tier descriptions neutral until production routes are certified",
		async (locale) => {
			const messages = await getUnifiedMessagesForLocale(locale);

			expect(JSON.stringify(messages.media)).not.toMatch(
				/fast private|higher[- ]fidelity|schnelle private|höherer detailtreue|privada rápida|mayor fidelidad|privée rapide|haute fidélité/i,
			);
		},
	);
});
