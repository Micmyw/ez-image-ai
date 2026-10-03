"use client";

import type { UnifiedAppMessages } from "@repo/i18n";
import { NextIntlClientProvider, useLocale, useMessages } from "next-intl";
import { type PropsWithChildren, useMemo } from "react";

export function AdminMessagesProvider({
	admin,
	children,
}: PropsWithChildren<{ admin: UnifiedAppMessages["admin"] }>) {
	const inheritedMessages = useMessages();
	const locale = useLocale();
	const messages = useMemo(() => ({ ...inheritedMessages, admin }), [inheritedMessages, admin]);

	return (
		<NextIntlClientProvider locale={locale} messages={messages}>
			{children}
		</NextIntlClientProvider>
	);
}
