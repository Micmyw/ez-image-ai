import { getUnifiedMessagesForLocale } from "@repo/i18n";
import { NextIntlClientProvider, useMessages, useTranslations } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ messages: vi.fn() }));
vi.mock("./StudioPanels", () => ({
	StudioPanels: () => {
		captured.messages(useMessages());
		const t = useTranslations("imagePass");
		return <p>{t("returnPending")}</p>;
	},
}));

import { LocalizedStudioPanels } from "./LocalizedStudioPanels";

describe("private panels on public editor routes", () => {
	it.each(["en", "de", "es", "fr"] as const)(
		"restores %s payment and library copy without a registered layout ancestor",
		async (locale) => {
			const full = await getUnifiedMessagesForLocale(locale);
			const { assets: _assets, edits: _edits, history: _history, ...publicMedia } = full.media;
			const publicMessages = {
				common: full.common,
				media: publicMedia,
				imagePass: { buy: full.imagePass.buy },
			};
			const onError = vi.fn();
			renderToStaticMarkup(
				<NextIntlClientProvider
					locale={locale}
					messages={publicMessages}
					timeZone="UTC"
					onError={onError}
				>
					<LocalizedStudioPanels panel={{ kind: "history" }} onChange={vi.fn()} onClose={vi.fn()} />
				</NextIntlClientProvider>,
			);
			expect(captured.messages).toHaveBeenLastCalledWith({
				...publicMessages,
				imagePass: full.imagePass,
				media: full.media,
			});
			expect(onError).not.toHaveBeenCalled();
		},
	);
});
