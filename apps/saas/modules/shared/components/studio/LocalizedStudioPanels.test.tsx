import { getUnifiedMessagesForLocale } from "@repo/i18n";
import { NextIntlClientProvider, useMessages, useTranslations } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ messages: vi.fn(), props: vi.fn() }));
vi.mock("./panels/HistoryDetailPanel", () => ({ HistoryDetailPanel: () => null }));
vi.mock("./StudioPanels", () => ({
	StudioPanels: (props: unknown) => {
		captured.messages(useMessages());
		captured.props(props);
		const t = useTranslations("imagePass");
		const assets = useTranslations("media.assets");
		const edits = useTranslations("media.edits");
		const history = useTranslations("media.history");
		const detail = useTranslations("media.detail");
		const settings = useTranslations("settings.account.changeName");
		return (
			<p>
				{assets("subtitle")} {edits("subtitle")} {history("subtitle")} {detail("back")}{" "}
				{t("returnPending")} {settings("title")}
			</p>
		);
	},
}));

import { LocalizedStudioPanels } from "./LocalizedStudioPanels";
import { studioPanelResources } from "./studio-panel-resources";

describe("private panels on public editor routes", () => {
	beforeEach(() => vi.clearAllMocks());
	it.each(["en", "de", "es", "fr"] as const)(
		"restores %s payment and library copy without a registered layout ancestor",
		async (locale) => {
			const full = await getUnifiedMessagesForLocale(locale);
			const resource = await studioPanelResources.load("history-detail", locale);
			expect(resource.messages).toEqual({
				imagePass: full.imagePass,
				media: {
					assets: full.media.assets,
					edits: full.media.edits,
					history: full.media.history,
				},
				settings: full.settings,
			});
			const { assets: _assets, edits: _edits, history, create, ...otherMedia } = full.media;
			const { preparation: _preparation, ...publicCreate } = create;
			const publicMedia = {
				...otherMedia,
				create: publicCreate,
				history: { title: history.title },
			};
			const publicMessages = {
				common: full.common,
				media: publicMedia,
				imagePass: { buy: full.imagePass.buy },
				parentOnly: { label: "Inherited application copy" },
			};
			const props = {
				panel: { kind: "history" as const, jobId: "existing-job" },
				onChange: vi.fn(),
				onClose: vi.fn(),
			};
			const onError = vi.fn();
			const markup = renderToStaticMarkup(
				<NextIntlClientProvider
					locale={locale}
					messages={publicMessages}
					timeZone="UTC"
					onError={onError}
				>
					<LocalizedStudioPanels {...props} />
				</NextIntlClientProvider>,
			);
			expect(captured.messages).toHaveBeenLastCalledWith({
				...publicMessages,
				imagePass: full.imagePass,
				settings: full.settings,
				media: {
					...publicMedia,
					assets: full.media.assets,
					edits: full.media.edits,
					history: full.media.history,
				},
			});
			expect(captured.props).toHaveBeenLastCalledWith({
				...props,
				component: resource.component,
			});
			expect(markup).toContain(full.media.assets.subtitle);
			expect(markup).toContain(full.settings.account.changeName.title);
			expect(onError).not.toHaveBeenCalled();
		},
	);
	it.each(["en", "de", "es", "fr"] as const)(
		"renders a localized loading status before the %s assets code is available",
		async (locale) => {
			const full = await getUnifiedMessagesForLocale(locale);
			const onError = vi.fn();
			const markup = renderToStaticMarkup(
				<NextIntlClientProvider
					locale={locale}
					messages={{ studio: full.studio }}
					timeZone="UTC"
					onError={onError}
				>
					<LocalizedStudioPanels panel={{ kind: "assets" }} onChange={vi.fn()} onClose={vi.fn()} />
				</NextIntlClientProvider>,
			);
			expect(markup).toContain(full.studio.loading);
			expect(markup).toContain('aria-live="polite"');
			expect(captured.props).not.toHaveBeenCalled();
			expect(onError).not.toHaveBeenCalled();
		},
	);
});
