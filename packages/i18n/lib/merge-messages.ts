import { toMerged } from "es-toolkit";

import { config, isLocale, type Locale } from "../config";
import { sharedMessages } from "./locale-loaders";

export async function mergeMessages<T>(
	locale: Locale,
	load: (locale: Locale) => Promise<Record<string, unknown>>,
): Promise<T> {
	if (!isLocale(locale)) throw new Error("UNSUPPORTED_MESSAGE_LOCALE");
	const [localized, shared] = await Promise.all([load(locale), sharedMessages[locale]()]);
	const messages = toMerged(localized, shared.default);
	if (locale === config.defaultLocale) return messages as T;
	const [fallback, fallbackShared] = await Promise.all([
		load(config.defaultLocale),
		sharedMessages[config.defaultLocale](),
	]);
	return toMerged(toMerged(fallback, fallbackShared.default), messages) as T;
}
