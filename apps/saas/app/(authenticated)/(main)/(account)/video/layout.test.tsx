import { getUnifiedMessagesForLocale } from "@repo/i18n";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getMessages: vi.fn(), requestLocale: "en" }));

vi.mock("next-intl/server", () => mocks);
vi.mock("next-intl", async (importOriginal) => {
	const actual = await importOriginal<typeof import("next-intl")>();
	return {
		...actual,
		// Vitest resolves the client export. The production react-server export
		// injects locale ?? await getLocaleCached() from the request config before
		// rendering this same client provider; retain real translation resolution.
		NextIntlClientProvider: ({
			locale,
			...props
		}: ComponentProps<typeof actual.NextIntlClientProvider>) => (
			<actual.NextIntlClientProvider {...props} locale={locale ?? mocks.requestLocale} />
		),
	};
});

import VideoLayout, { metadata } from "./layout";

function VideoCopy() {
	const t = useTranslations("videoV1");
	return (
		<main>
			<h1>{t("title")}</h1>
			<button type="button">{t("reviewPrice")}</button>
		</main>
	);
}

function AccountNavigationCopy() {
	const t = useTranslations("app.menu");
	return <nav aria-label={t("video")}>{t("video")}</nav>;
}

describe("authenticated video layout translation boundary", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.requestLocale = "en";
	});

	it.each(["en", "de", "es", "fr"] as const)(
		"supplies %s video copy locally while the surrounding account shell keeps its root messages",
		async (locale) => {
			const messages = await getUnifiedMessagesForLocale(locale);
			mocks.requestLocale = locale;
			mocks.getMessages.mockResolvedValue(messages);
			const layout = await VideoLayout({ children: <VideoCopy /> });

			expect(layout.props.messages).toEqual({ videoV1: messages.videoV1 });
			const markup = renderToStaticMarkup(
				<NextIntlClientProvider locale={locale} messages={{ app: messages.app }} timeZone="UTC">
					<AccountNavigationCopy />
					{layout}
				</NextIntlClientProvider>,
			);

			expect(markup).toBe(
				renderToStaticMarkup(
					<>
						<nav aria-label={messages.app.menu.video}>{messages.app.menu.video}</nav>
						<main>
							<h1>{messages.videoV1.title}</h1>
							<button type="button">{messages.videoV1.reviewPrice}</button>
						</main>
					</>,
				),
			);
		},
	);

	it("keeps video routes non-indexable", () => {
		expect(metadata.robots).toEqual({ index: false, follow: false });
	});
});
