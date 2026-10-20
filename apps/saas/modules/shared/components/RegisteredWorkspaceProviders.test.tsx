import { getUnifiedMessagesForLocale } from "@repo/i18n";
import {
	type AbstractIntlMessages,
	NextIntlClientProvider,
	useMessages,
	useTranslations,
} from "next-intl";
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

function PaymentCopy({
	expected,
	media,
	checkoutReturn,
	creditPackCheckoutReturn,
}: {
	expected: Record<string, string>;
	media: AbstractIntlMessages;
	checkoutReturn: Record<string, string>;
	creditPackCheckoutReturn: Record<string, string>;
}) {
	const t = useTranslations("imagePass");
	const subscription = useTranslations("checkoutReturn");
	const credits = useTranslations("creditPackCheckoutReturn");
	const common = useTranslations("common");
	const preparation = useTranslations("media.create.preparation");
	expect(useMessages().imagePass).toEqual(expected);
	expect(useMessages().media).toEqual(media);
	expect(useMessages().checkoutReturn).toEqual(checkoutReturn);
	expect(useMessages().creditPackCheckoutReturn).toEqual(creditPackCheckoutReturn);
	return (
		<p>
			{t("title", { units: 3 })} {t("returnPending")} {common("menu.login")} {preparation("title")}{" "}
			{subscription("completed")} {credits("loading")}
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
					messages={{
						common: messages.common,
						imagePass: { buy: messages.imagePass.buy },
						media: {
							create: Object.fromEntries(
								Object.entries(messages.media.create).filter(([key]) => key !== "preparation"),
							),
							guest: messages.media.guest,
							status: messages.media.status,
							safety: messages.media.safety,
						},
					}}
					onError={onError}
				>
					<RegisteredWorkspaceProviders
						imagePassMessages={messages.imagePass}
						mediaMessages={messages.media}
						checkoutReturnMessages={messages.checkoutReturn}
						creditPackCheckoutReturnMessages={messages.creditPackCheckoutReturn}
					>
						<PaymentCopy
							expected={messages.imagePass}
							media={messages.media}
							checkoutReturn={messages.checkoutReturn}
							creditPackCheckoutReturn={messages.creditPackCheckoutReturn}
						/>
					</RegisteredWorkspaceProviders>
				</NextIntlClientProvider>,
			);
			expect(markup).toBe(
				renderToStaticMarkup(
					<p>
						{messages.imagePass.title.replace("{units}", "3")} {messages.imagePass.returnPending}{" "}
						{messages.common.menu.login} {messages.media.create.preparation.title}{" "}
						{messages.checkoutReturn.completed} {messages.creditPackCheckoutReturn.loading}
					</p>,
				),
			);
			expect(onError).not.toHaveBeenCalled();
		},
	);
});
