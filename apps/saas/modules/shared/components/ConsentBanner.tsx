"use client";

import { Button } from "@repo/ui/components/button";
import { useCookieConsent } from "@shared/hooks/cookie-consent";
import { CookieIcon } from "lucide-react";
import { useTranslations } from "next-intl";

export function ConsentBanner() {
	const t = useTranslations("common.consent");
	const { consentStatus, allowCookies, declineCookies } = useCookieConsent();

	if (consentStatus !== "undecided") {
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
					<p className="text-sm leading-normal flex-1">{t("message")}</p>
					<div className="gap-2 sm:shrink-0 flex flex-wrap">
						<Button variant="secondary" className="flex-1" onClick={() => declineCookies()}>
							{t("decline")}
						</Button>
						<Button className="flex-1" onClick={() => allowCookies()}>
							{t("allow")}
						</Button>
					</div>
				</div>
			</div>
		</section>
	);
}
