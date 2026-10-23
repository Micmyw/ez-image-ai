import type { Locale } from "../config";
import type { MailMessages } from "../types";
import { mailMessages } from "./locale-loaders";
import { mergeMessages } from "./merge-messages";

export function getMailMessagesForLocale(locale: Locale): Promise<MailMessages> {
	return mergeMessages<MailMessages>(locale, async (selected) => {
		return (await mailMessages[selected]()).default;
	});
}
