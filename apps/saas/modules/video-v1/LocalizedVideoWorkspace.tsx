"use client";

import de from "@repo/i18n/translations/de/video.json";
import en from "@repo/i18n/translations/en/video.json";
import es from "@repo/i18n/translations/es/video.json";
import fr from "@repo/i18n/translations/fr/video.json";
import { NextIntlClientProvider, useLocale, useMessages } from "next-intl";

import { VideoWorkspace } from "./VideoWorkspace";

const videoMessages = { de: de.videoV1, en: en.videoV1, es: es.videoV1, fr: fr.videoV1 };

/** Detailed video copy travels with the existing lazy video view, not the image homepage. */
export function LocalizedVideoWorkspace({ initialJobId }: { initialJobId: string | null }) {
	const locale = useLocale();
	const messages = useMessages();
	const videoV1 = videoMessages[locale as keyof typeof videoMessages] ?? en.videoV1;
	return (
		<NextIntlClientProvider locale={locale} messages={{ ...messages, videoV1 }}>
			<VideoWorkspace initialJobId={initialJobId} />
		</NextIntlClientProvider>
	);
}
