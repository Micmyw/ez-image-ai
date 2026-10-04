import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";

import de from "../../../../packages/i18n/translations/de/saas.json";
import en from "../../../../packages/i18n/translations/en/saas.json";
import es from "../../../../packages/i18n/translations/es/saas.json";
import fr from "../../../../packages/i18n/translations/fr/saas.json";

function shape(value: unknown, prefix = ""): string[] {
	if (typeof value === "string")
		return [
			`${prefix}:${[...value.matchAll(/\{(\w+)(?:[,}])/g)]
				.map((match) => match[1])
				.sort()
				.join(",")}`,
		];
	return Object.entries(value as Record<string, unknown>)
		.flatMap(([key, nested]) => shape(nested, `${prefix}.${key}`))
		.sort();
}

describe("private video translations", () => {
	it.each([
		{ locale: "en", messages: en },
		{ locale: "de", messages: de },
		{ locale: "es", messages: es },
		{ locale: "fr", messages: fr },
	])("keeps $locale keys and placeholders aligned and renders credits", ({ locale, messages }) => {
		expect(shape(messages.videoV1)).toEqual(shape(en.videoV1));
		const t = createTranslator({ locale, messages, namespace: "videoV1" });
		expect(t("quote", { credits: "23" })).toContain("23");
		expect(t("uploading", { progress: 74 })).toContain("74");
		expect(t("credits.RESERVED", { credits: "23" })).toContain("23");
		expect(t("stages.SUBMISSION_UNCERTAIN")).not.toBe("stages.SUBMISSION_UNCERTAIN");
		expect(messages.app.menu.video).toBeTruthy();
	});
});
