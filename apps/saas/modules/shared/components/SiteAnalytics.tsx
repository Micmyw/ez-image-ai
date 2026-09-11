"use client";

import { startSiteAnalytics } from "@shared/lib/site-analytics";
import { useEffect } from "react";

export function SiteAnalytics() {
	useEffect(
		() =>
			startSiteAnalytics({
				browser: window,
				googleAnalyticsId: process.env.NEXT_PUBLIC_GOOGLE_ANALYTICS_ID,
				clarityProjectId: process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID,
			}),
		[],
	);
	return null;
}
