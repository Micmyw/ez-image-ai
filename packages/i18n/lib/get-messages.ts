import { toMerged } from "es-toolkit";

import type { Locale } from "../config";
import type { MarketingMessages, SaasMessages } from "../types";
import { marketingMessages, saasMessages, videoMessages } from "./locale-loaders";
import { getMailMessagesForLocale } from "./mail-messages";
import { mergeMessages } from "./merge-messages";

export type TranslationScope = "marketing" | "saas" | "mail";

export async function getMessagesForLocale<T = Record<string, unknown>>(
	locale: Locale,
	scope: TranslationScope,
): Promise<T> {
	if (scope === "mail") return getMailMessagesForLocale(locale) as Promise<T>;
	return mergeMessages<T>(locale, async (selected) => {
		if (scope === "marketing") return (await marketingMessages[selected]()).default;
		const [saas, video] = await Promise.all([saasMessages[selected](), videoMessages[selected]()]);
		return { ...saas.default, ...video.default };
	});
}

export async function getUnifiedMessagesForLocale(
	locale: Locale,
): Promise<MarketingMessages & SaasMessages> {
	const [marketingMessages, saasMessages] = await Promise.all([
		getMessagesForLocale<MarketingMessages>(locale, "marketing"),
		getMessagesForLocale<SaasMessages>(locale, "saas"),
	]);

	return toMerged(
		marketingMessages as Record<string, unknown>,
		saasMessages as Record<string, unknown>,
	) as MarketingMessages & SaasMessages;
}
