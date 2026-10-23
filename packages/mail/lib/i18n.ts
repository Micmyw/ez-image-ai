import type { MailMessages } from "@repo/i18n";
import { getMailMessagesForLocale } from "@repo/i18n/lib/mail-messages";

export type Messages = MailMessages;

export const getMessagesForLocale = async (
	locale: Parameters<typeof getMailMessagesForLocale>[0],
): Promise<Messages> => {
	return getMailMessagesForLocale(locale);
};
