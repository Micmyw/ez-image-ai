"use client";

import { useCookieConsent } from "@shared/hooks/cookie-consent";
import { startSiteAnalytics } from "@shared/lib/site-analytics";
import { useEffect } from "react";

export function SiteAnalytics() {
	const { analyticsAllowed } = useCookieConsent();
	useEffect(
		() =>
			startSiteAnalytics({
				browser: window,
				analyticsAllowed,
				googleAnalyticsId: process.env.NEXT_PUBLIC_GOOGLE_ANALYTICS_ID,
				clarityProjectId: process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID,
			}),
		[analyticsAllowed],
	);
	return null;
}
