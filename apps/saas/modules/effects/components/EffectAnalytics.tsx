"use client";

import { setBrowserGrowthAnalyticsSuppressed } from "@repo/utils";
import { useCookieConsent } from "@shared/hooks/cookie-consent";
import { useEffect } from "react";

import { recordEffectViewed, type EffectAnalyticsOptions } from "../lib/analytics";
import type { EffectPageContent } from "../lib/types";

export function EffectAnalytics({
	effect,
	initialPresetId,
	sourceBlogId,
	allowedSourceBlogIds,
	internalSource,
	preview = false,
}: EffectAnalyticsOptions & { effect: EffectPageContent; initialPresetId: string }) {
	const { userHasConsented } = useCookieConsent();
	useEffect(() => {
		void recordEffectViewed(effect, initialPresetId, {
			sourceBlogId,
			allowedSourceBlogIds,
			internalSource,
			preview,
		});
	}, [
		effect,
		initialPresetId,
		sourceBlogId,
		allowedSourceBlogIds,
		internalSource,
		preview,
		userHasConsented,
	]);
	useEffect(() => () => setBrowserGrowthAnalyticsSuppressed(false), []);
	return null;
}
