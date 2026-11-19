"use client";

import {
	PORTRAIT_PACK_OBSERVED,
	type PortraitPackCta,
	type PortraitPackObservationStage,
	type PortraitPackPlacement,
} from "@repo/config/portrait-packs";
import { trackBrowserGrowthEvent } from "@repo/utils/lib/growth-analytics-browser";
import { useCookieConsent } from "@shared/hooks/cookie-consent";
import { useCallback, useEffect, useState } from "react";

export function usePortraitPackAnalytics(
	placement: PortraitPackPlacement,
	cta: PortraitPackCta,
	active: boolean,
) {
	const { userHasConsented } = useCookieConsent();
	const [button, ref] = useState<HTMLButtonElement | null>(null);
	const record = useCallback(
		(stage: PortraitPackObservationStage) => {
			if (!active || !userHasConsented || document.visibilityState !== "visible") return;
			void trackBrowserGrowthEvent(
				{ name: PORTRAIT_PACK_OBSERVED, properties: { portraitPack: { placement, cta, stage } } },
				{ dedupeKey: `portrait-pack:${placement}:${cta}:${stage}` },
			);
		},
		[active, cta, placement, userHasConsented],
	);

	useEffect(() => {
		if (!active || !userHasConsented || !button || typeof IntersectionObserver === "undefined")
			return;
		let visible = false;
		const onVisible = () => {
			if (visible) record("impression");
		};
		const observer = new IntersectionObserver(([entry]) => {
			visible = Boolean(entry?.isIntersecting && entry.intersectionRatio > 0);
			onVisible();
		});
		observer.observe(button);
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			observer.disconnect();
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [active, button, record, userHasConsented]);

	function clicked() {
		// A fast or keyboard interaction can precede the first observer frame.
		record("impression");
		record("clicked");
	}

	return { ref, clicked };
}
