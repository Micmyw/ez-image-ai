import { getUnifiedMessagesForLocale } from "@repo/i18n";
import { NextIntlClientProvider, useMessages, useTranslations } from "next-intl";
import type { PropsWithChildren } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

function passthrough({ children }: PropsWithChildren) {
	return children;
}
vi.mock("@auth/components/SessionProvider", () => ({ SessionProvider: passthrough }));
vi.mock("next/dynamic", () => ({ default: () => passthrough }));
vi.mock("./ConfirmationAlertProvider", () => ({ ConfirmationAlertProvider: passthrough }));

import { RegisteredWorkspaceProviders } from "./RegisteredWorkspaceProviders";

function PaymentCopy({ expected }: { expected: Record<string, string> }) {
	const t = useTranslations("imagePass");
	const common = useTranslations("common");
	expect(useMessages().imagePass).toEqual(expected);
	return (
		<p>
			{t("title", { units: 3 })} {t("returnPending")} {common("menu.login")}
		</p>
	);
}

describe("registered image pass translations", () => {
	it.each(["en", "de", "es", "fr"] as const)(
		"restores all private payment copy in %s while retaining shared messages",
		async (locale) => {
			const messages = await getUnifiedMessagesForLocale(locale);
			const onError = vi.fn();
			const markup = renderToStaticMarkup(
				<NextIntlClientProvider
					locale={locale}
					timeZone="UTC"
					messages={{ common: messages.common, imagePass: { buy: messages.imagePass.buy } }}
					onError={onError}
				>
					<RegisteredWorkspaceProviders imagePassMessages={messages.imagePass}>
						<PaymentCopy expected={messages.imagePass} />
					</RegisteredWorkspaceProviders>
				</NextIntlClientProvider>,
			);
			expect(markup).toBe(
				renderToStaticMarkup(
					<p>
						{messages.imagePass.title.replace("{units}", "3")} {messages.imagePass.returnPending}{" "}
						{messages.common.menu.login}
					</p>,
				),
			);
			expect(onError).not.toHaveBeenCalled();
		},
	);
});
