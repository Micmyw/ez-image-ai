"use client";

import type { UnifiedAppMessages } from "@repo/i18n";
import { NextIntlClientProvider, useLocale, useMessages } from "next-intl";
import { type PropsWithChildren, useMemo } from "react";

export function AdminMessagesProvider({
	admin,
	locale,
	children,
}: PropsWithChildren<{ admin: UnifiedAppMessages["admin"]; locale?: string }>) {
	const inheritedMessages = useMessages();
	const inheritedLocale = useLocale();
	const messages = useMemo(() => ({ ...inheritedMessages, admin }), [inheritedMessages, admin]);

	return (
		<NextIntlClientProvider locale={locale ?? inheritedLocale} messages={messages}>
			<div lang={locale ?? inheritedLocale}>{children}</div>
		</NextIntlClientProvider>
	);
}
