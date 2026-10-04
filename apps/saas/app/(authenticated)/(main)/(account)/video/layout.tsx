import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";
import type { PropsWithChildren } from "react";

export const metadata: Metadata = { title: "Video beta", robots: { index: false, follow: false } };

export default async function VideoLayout({ children }: PropsWithChildren) {
	const messages = await getMessages();
	return (
		<NextIntlClientProvider messages={{ videoV1: messages.videoV1 }}>
			{children}
		</NextIntlClientProvider>
	);
}
