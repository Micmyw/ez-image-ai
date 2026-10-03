"use client";

import { setBrowserGrowthAnalyticsSuppressed } from "@repo/utils";
import { useCookieConsent } from "@shared/hooks/cookie-consent";
import { useEffect } from "react";

import { recordBlogViewed, type BlogAnalyticsPost } from "../../effects/lib/analytics";

export function BlogAnalytics({
	post,
	preview = false,
}: {
	post: BlogAnalyticsPost;
	preview?: boolean;
}) {
	const { userHasConsented } = useCookieConsent();
	useEffect(() => {
		void recordBlogViewed(post, preview);
	}, [post, preview, userHasConsented]);
	useEffect(() => () => setBrowserGrowthAnalyticsSuppressed(false), []);
	return null;
}
