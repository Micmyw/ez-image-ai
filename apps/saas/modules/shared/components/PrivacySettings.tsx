"use client";

import { useCookieConsent } from "@shared/hooks/cookie-consent";
import { useTranslations } from "next-intl";

export function PrivacySettings() {
	const { openPreferences } = useCookieConsent();
	const t = useTranslations("common.consent");
	return (
		<button
			type="button"
			className="text-xs underline underline-offset-4"
			onClick={() => {
				openPreferences();
				window.scrollTo({ top: 0, behavior: "instant" });
			}}
		>
			{t("settings")}
		</button>
	);
}
