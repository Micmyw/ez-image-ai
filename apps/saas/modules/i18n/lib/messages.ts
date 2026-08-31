import { getUnifiedMessagesForLocale, type UnifiedAppMessages } from "@repo/i18n";

export const getMessagesForLocale = async (locale: string): Promise<UnifiedAppMessages> => {
	return getUnifiedMessagesForLocale(locale as Parameters<typeof getUnifiedMessagesForLocale>[0]);
};
