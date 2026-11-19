"use client";

import { Button } from "@repo/ui/components/button";
import { publicAnalyticsPath } from "@repo/utils/lib/analytics-page";
import { useCookieConsent } from "@shared/hooks/cookie-consent";
import { CookieIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import { type RefObject, useEffect, useRef } from "react";

import styles from "./ConsentBanner.module.css";

export function ConsentBanner({
	returnFocus,
}: { returnFocus?: RefObject<HTMLElement | null> } = {}) {
	const t = useTranslations("common.consent");
	const pathname = usePathname();
	const banner = useRef<HTMLElement>(null);
	const {
		showBanner,
		preferencesOpen,
		preferencesTrigger,
		policyReady,
		privacySignal,
		allowCookies,
		declineCookies,
		closePreferences,
	} = useCookieConsent();
	const automaticNoticeAllowed =
		pathname !== null && publicAnalyticsPath(new URL(pathname, "https://consent.invalid")) !== null;
	const inCheckout = pathname === "/image-pass" && !returnFocus;

	useEffect(() => {
		if (preferencesOpen && !returnFocus) banner.current?.focus({ preventScroll: !inCheckout });
	}, [inCheckout, preferencesOpen, returnFocus]);

	// Account pages retain explicit privacy choices without an automatic notice.
	if (!showBanner || (!preferencesOpen && !automaticNoticeAllowed)) {
		return null;
	}

	function choose(action: () => void) {
		action();
		if (returnFocus?.current) returnFocus.current.focus();
		else preferencesTrigger?.focus({ preventScroll: !inCheckout });
	}

	const placement = returnFocus ? styles.inDialog : inCheckout ? styles.checkout : styles.viewport;
	return (
		<section
			ref={banner}
			data-consent-banner=""
			aria-label={t("label")}
			tabIndex={-1}
			className={`bg-card text-card-foreground ${placement}`}
		>
			<div className="gap-2 p-3 sm:p-4 flex items-start">
				<CookieIcon className="mt-0.5 size-4 shrink-0 text-primary/60" aria-hidden="true" />
				<div className="min-w-0 gap-2 flex flex-1 flex-col">
					<div className="text-xs leading-relaxed">
						<p className="mb-1 text-sm font-semibold">{t("label")}</p>
						<p>
							{t("message")}{" "}
							<a href="/privacy" className="whitespace-nowrap underline underline-offset-2">
								{t("policy")}
							</a>
						</p>
						{privacySignal && <p>{t("privacySignal")}</p>}
					</div>
					<div className="gap-1.5 flex flex-wrap">
						<Button
							type="button"
							size="sm"
							variant="secondary"
							className="min-h-9 flex-1"
							onClick={() => choose(declineCookies)}
						>
							{t("decline")}
						</Button>
						<Button
							type="button"
							size="sm"
							className="min-h-9 flex-1"
							disabled={!policyReady || privacySignal}
							onClick={() => choose(allowCookies)}
						>
							{t("allow")}
						</Button>
						<Button
							type="button"
							size="sm"
							variant="ghost"
							className="min-h-9"
							onClick={() => choose(closePreferences)}
						>
							{t("close")}
						</Button>
					</div>
				</div>
			</div>
		</section>
	);
}
