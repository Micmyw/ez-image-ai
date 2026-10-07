"use client";

import { videoV1 as de } from "@repo/i18n/translations/de/saas.json";
import { videoV1 as en } from "@repo/i18n/translations/en/saas.json";
import { videoV1 as es } from "@repo/i18n/translations/es/saas.json";
import { videoV1 as fr } from "@repo/i18n/translations/fr/saas.json";
import { NextIntlClientProvider, useLocale, useMessages } from "next-intl";

import { VideoWorkspace } from "./VideoWorkspace";

const videoMessages = { de, en, es, fr };

/** Detailed video copy travels with the existing lazy video view, not the image homepage. */
export function LocalizedVideoWorkspace({ initialJobId }: { initialJobId: string | null }) {
	const locale = useLocale();
	const messages = useMessages();
	const videoV1 = videoMessages[locale as keyof typeof videoMessages] ?? en;
	return (
		<NextIntlClientProvider locale={locale} messages={{ ...messages, videoV1 }}>
			<VideoWorkspace initialJobId={initialJobId} />
		</NextIntlClientProvider>
	);
}
