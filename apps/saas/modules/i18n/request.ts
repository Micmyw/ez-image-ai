import { config as i18nConfig, isLocale } from "@repo/i18n";
import { getRequestConfig } from "next-intl/server";
import { cookies } from "next/headers";

import { resolveRequestLocale } from "./lib/locale";
import { getMessagesForLocale } from "./lib/messages";

export default getRequestConfig(async ({ requestLocale }) => {
	const requestedLocale = await requestLocale;
	let cookieLocale: string | undefined;

	if (!isLocale(requestedLocale)) {
		const cookieStore = await cookies();
		cookieLocale = cookieStore.get(i18nConfig.localeCookieName)?.value;
	}
	const locale = resolveRequestLocale(requestedLocale, cookieLocale);

	return {
		locale,
		messages: await getMessagesForLocale(locale),
	};
});
