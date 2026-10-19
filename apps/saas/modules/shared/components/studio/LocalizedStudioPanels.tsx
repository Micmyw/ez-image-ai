"use client";

import { media as de } from "@repo/i18n/translations/de/saas.json";
import { media as en } from "@repo/i18n/translations/en/saas.json";
import { media as es } from "@repo/i18n/translations/es/saas.json";
import { media as fr } from "@repo/i18n/translations/fr/saas.json";
import { NextIntlClientProvider, useLocale, useMessages } from "next-intl";
import type { ComponentProps } from "react";

import { StudioPanels } from "./StudioPanels";

function privateMedia(media: Pick<typeof en, "assets" | "edits" | "history">) {
	return { assets: media.assets, edits: media.edits, history: media.history };
}

const panelMessages = {
	de: privateMedia(de),
	en: privateMedia(en),
	es: privateMedia(es),
	fr: privateMedia(fr),
};

/** Public editor routes can open panels outside the registered layout.
 * Their private copy travels with the existing lazy panel view. */
export function LocalizedStudioPanels(props: ComponentProps<typeof StudioPanels>) {
	const locale = useLocale();
	const messages = useMessages();
	const media = messages.media;
	const selected = panelMessages[locale as keyof typeof panelMessages] ?? panelMessages.en;
	return (
		<NextIntlClientProvider
			locale={locale}
			messages={{
				...messages,
				media: { ...(media && typeof media === "object" ? media : {}), ...selected },
			}}
		>
			<StudioPanels {...props} />
		</NextIntlClientProvider>
	);
}
