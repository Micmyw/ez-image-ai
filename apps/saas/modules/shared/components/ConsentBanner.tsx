"use client";

import { Button } from "@repo/ui/components/button";
import { publicAnalyticsPath } from "@repo/utils/lib/analytics-page";
import { useCookieConsent } from "@shared/hooks/cookie-consent";
import { CookieIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { usePathname } from "next/navigation";

export function ConsentBanner() {
	const t = useTranslations("common.consent");
	const pathname = usePathname();
	const {
		showBanner,
		preferencesOpen,
		privacySignal,
		allowCookies,
		declineCookies,
		closePreferences,
	} = useCookieConsent();
	const automaticNoticeAllowed =
		pathname !== null && publicAnalyticsPath(new URL(pathname, "https://consent.invalid")) !== null;

	// Account pages retain explicit privacy choices without an automatic notice.
	if (!showBanner || (!preferencesOpen && !automaticNoticeAllowed)) {
		return null;
	}

	return (
		<section
			data-consent-banner=""
			aria-label={t("label")}
			className="border-b bg-card text-card-foreground"
		>
			<div className="gap-2 py-2 container flex items-start">
				<CookieIcon className="mt-0.5 size-4 shrink-0 text-primary/60" aria-hidden="true" />
				<div className="min-w-0 gap-2 sm:flex-row sm:items-center sm:gap-4 flex flex-1 flex-col">
					<div className="text-xs leading-relaxed flex-1">
						<h2 className="mb-1 text-sm font-semibold">{t("label")}</h2>
						<p>
							{t("message")}{" "}
							<a href="/privacy" className="whitespace-nowrap underline underline-offset-2">
								{t("policy")}
							</a>
						</p>
						{privacySignal && <p>{t("privacySignal")}</p>}
					</div>
					<div className="gap-1.5 sm:shrink-0 flex flex-wrap">
						<Button
							size="sm"
							variant="secondary"
							className="h-8 sm:h-7 flex-1"
							onClick={() => declineCookies()}
						>
							{t("decline")}
						</Button>
						<Button
							size="sm"
							className="h-8 sm:h-7 flex-1"
							disabled={privacySignal}
							onClick={() => allowCookies()}
						>
							{t("allow")}
						</Button>
						<Button size="sm" variant="ghost" className="h-8 sm:h-7" onClick={closePreferences}>
							{t("close")}
						</Button>
					</div>
				</div>
			</div>
		</section>
	);
}
