import { getUnifiedMessagesForLocale } from "@repo/i18n";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AdminMessagesProvider } from "./AdminMessagesProvider";

function MessageProbe() {
	const admin = useTranslations("admin");
	const common = useTranslations("common");
	return (
		<span>
			{admin("title")} / {common("menu.login")}
		</span>
	);
}

describe("admin client translations", () => {
	it.each(["en", "de", "es", "fr"] as const)(
		"adds %s admin translations while retaining the inherited application messages",
		async (locale) => {
			const { admin, ...messages } = await getUnifiedMessagesForLocale(locale);
			const markup = renderToStaticMarkup(
				<NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
					<AdminMessagesProvider admin={admin}>
						<MessageProbe />
					</AdminMessagesProvider>
				</NextIntlClientProvider>,
			);

			expect(markup).toBe(
				renderToStaticMarkup(
					<span>
						{admin.title} / {messages.common.menu.login}
					</span>,
				),
			);
		},
	);
});
