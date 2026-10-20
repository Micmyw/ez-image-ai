import { getMessagesForLocale, type SaasMessages } from "@repo/i18n";
import deVideo from "@repo/i18n/translations/de/video.json";
import enVideo from "@repo/i18n/translations/en/video.json";
import esVideo from "@repo/i18n/translations/es/video.json";
import frVideo from "@repo/i18n/translations/fr/video.json";
import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";

const [de, en, es, fr] = await Promise.all(
	(["de", "en", "es", "fr"] as const).map((locale) =>
		getMessagesForLocale<SaasMessages>(locale, "saas"),
	),
);

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
		{ locale: "en", messages: en, video: enVideo },
		{ locale: "de", messages: de, video: deVideo },
		{ locale: "es", messages: es, video: esVideo },
		{ locale: "fr", messages: fr, video: frVideo },
	])(
		"keeps $locale keys and placeholders aligned and renders credits",
		({ locale, messages, video }) => {
			// Compare raw files so English fallback cannot conceal a missing translation.
			expect(shape(video.videoV1)).toEqual(shape(enVideo.videoV1));
			expect(messages.videoV1).toEqual(video.videoV1);
			const t = createTranslator({ locale, messages, namespace: "videoV1" });
			expect(t("quote", { credits: "23" })).toContain("23");
			expect(t("uploading", { progress: 74 })).toContain("74");
			expect(t("credits.RESERVED", { credits: "23" })).toContain("23");
			expect(t("stages.SUBMISSION_UNCERTAIN")).not.toBe("stages.SUBMISSION_UNCERTAIN");
			expect(messages.app.menu.video).toBeTruthy();
		},
	);
});
