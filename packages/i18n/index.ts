export { config, type Locale } from "./config";
export { getMessagesForLocale, getUnifiedMessagesForLocale } from "./lib/get-messages";
export { default as defaultMailTranslations } from "./translations/en/mail.json";
export type {
	MailMessages,
	MarketingMessages,
	SaasMessages,
	SharedMessages,
	UnifiedAppMessages,
} from "./types";
