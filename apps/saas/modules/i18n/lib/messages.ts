import { getUnifiedMessagesForLocale, type Locale, type UnifiedAppMessages } from "@repo/i18n";

const messagesByLocale = new Map<Locale, Promise<UnifiedAppMessages>>();

function freezeMessages(messages: object): void {
	for (const value of Object.values(messages)) {
		if (value !== null && typeof value === "object") freezeMessages(value);
	}
	Object.freeze(messages);
}

export async function getMessagesForLocale(locale: Locale): Promise<UnifiedAppMessages> {
	if (process.env.NODE_ENV !== "production") return getUnifiedMessagesForLocale(locale);

	const cached = messagesByLocale.get(locale);
	if (cached) return cached;

	// The shared promise depends only on the current build's bundled translation modules.
	const pending = getUnifiedMessagesForLocale(locale)
		.then((messages) => {
			freezeMessages(messages);
			return messages;
		})
		.catch((error) => {
			messagesByLocale.delete(locale);
			throw error;
		});
	messagesByLocale.set(locale, pending);
	return pending;
}
