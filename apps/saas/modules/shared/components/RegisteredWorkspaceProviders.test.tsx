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
}: {
	expected: Record<string, string>;
	media: AbstractIntlMessages;
}) {
	const t = useTranslations("imagePass");
	const common = useTranslations("common");
	expect(useMessages().imagePass).toEqual(expected);
	expect(useMessages().media).toEqual(media);
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
					messages={{
						common: messages.common,
						imagePass: { buy: messages.imagePass.buy },
						media: {
							create: messages.media.create,
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
					>
						<PaymentCopy expected={messages.imagePass} media={messages.media} />
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
