"use client";

import { Button } from "@repo/ui/components/button";
import { useCookieConsent } from "@shared/hooks/cookie-consent";
import { CookieIcon } from "lucide-react";
import { useTranslations } from "next-intl";

export function ConsentBanner() {
	const t = useTranslations("common.consent");
	const { showBanner, privacySignal, allowCookies, declineCookies, closePreferences } =
		useCookieConsent();

	if (!showBanner) {
		return null;
	}

	return (
		<section
			data-consent-banner=""
			aria-label={t("label")}
			className="border-b bg-card text-card-foreground"
		>
			<div className="gap-3 py-3 container flex items-start">
				<CookieIcon className="mt-1 size-5 shrink-0 text-primary/60" aria-hidden="true" />
				<div className="min-w-0 gap-3 sm:flex-row sm:items-center sm:gap-6 flex flex-1 flex-col">
					<div className="text-sm leading-normal flex-1">
						<p>{t("message")}</p>
						<a href="/privacy" className="underline">
							{t("policy")}
						</a>
						{privacySignal && <p>{t("privacySignal")}</p>}
					</div>
					<div className="gap-2 sm:shrink-0 flex flex-wrap">
						<Button variant="secondary" className="flex-1" onClick={() => declineCookies()}>
							{t("decline")}
						</Button>
						<Button className="flex-1" disabled={privacySignal} onClick={() => allowCookies()}>
							{t("allow")}
						</Button>
						<Button variant="ghost" onClick={closePreferences}>
							{t("close")}
						</Button>
					</div>
				</div>
			</div>
		</section>
	);
}
