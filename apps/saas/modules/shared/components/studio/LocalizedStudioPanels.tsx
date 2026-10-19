"use client";

import { imagePass as dePass, media as deMedia } from "@repo/i18n/translations/de/saas.json";
import { imagePass as enPass, media as enMedia } from "@repo/i18n/translations/en/saas.json";
import { imagePass as esPass, media as esMedia } from "@repo/i18n/translations/es/saas.json";
import { imagePass as frPass, media as frMedia } from "@repo/i18n/translations/fr/saas.json";
import { NextIntlClientProvider, useLocale, useMessages } from "next-intl";
import type { ComponentProps } from "react";

import { StudioPanels } from "./StudioPanels";

function privateMedia(media: Pick<typeof enMedia, "assets" | "edits" | "history">) {
	return { assets: media.assets, edits: media.edits, history: media.history };
}

const panelMessages = {
	de: { imagePass: dePass, media: privateMedia(deMedia) },
	en: { imagePass: enPass, media: privateMedia(enMedia) },
	es: { imagePass: esPass, media: privateMedia(esMedia) },
	fr: { imagePass: frPass, media: privateMedia(frMedia) },
};

/** Panels can open on public editor routes outside RegisteredWorkspaceBoundary.
 * Their private copy travels with this existing lazy view, never the anonymous homepage. */
export function LocalizedStudioPanels(props: ComponentProps<typeof StudioPanels>) {
	const locale = useLocale();
	const messages = useMessages();
	const selected = panelMessages[locale as keyof typeof panelMessages] ?? panelMessages.en;
	const media = messages.media;
	return (
		<NextIntlClientProvider
			locale={locale}
			messages={{
				...messages,
				imagePass: selected.imagePass,
				media: { ...(media && typeof media === "object" ? media : {}), ...selected.media },
			}}
		>
			<StudioPanels {...props} />
		</NextIntlClientProvider>
	);
}
