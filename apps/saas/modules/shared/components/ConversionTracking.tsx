"use client";

import { useSessionQuery } from "@auth/lib/api";
import { publicAnalyticsPath } from "@repo/utils/lib/analytics-page";
import { captureConversionEntry } from "@repo/utils/lib/conversion-entry";
import { trackBrowserGrowthEvent } from "@repo/utils/lib/growth-analytics-browser";
import { useCookieConsent } from "@shared/hooks/cookie-consent";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

export function ConversionTracking() {
	const pathname = usePathname();
	const { analyticsAllowed } = useCookieConsent();
	const session = useSessionQuery();
	const user = session.data?.user;
	const lastPage = useRef<string | null>(null);
	const lastUser = useRef<string | null>(null);
	useEffect(() => {
		captureConversionEntry();
	}, []);
	useEffect(() => {
		if (!analyticsAllowed || user?.role === "admin") {
			lastPage.current = null;
			return;
		}
		const path = publicAnalyticsPath(new URL(window.location.href));
		if (path && lastPage.current !== path) {
			lastPage.current = path;
			void trackBrowserGrowthEvent({ name: "page_viewed" });
		} else if (!path) lastPage.current = null;
	}, [pathname, analyticsAllowed, user?.role]);
	useEffect(() => {
		if (!analyticsAllowed || !user || user.isAnonymous) {
			lastUser.current = null;
			return;
		}
		if (lastUser.current === user.id) return;
		lastUser.current = user.id;
		// The API resolves identity from the session; no browser-supplied user ID is accepted.
		void trackBrowserGrowthEvent({ name: "identity_observed" });
	}, [user, analyticsAllowed]);
	return null;
}
