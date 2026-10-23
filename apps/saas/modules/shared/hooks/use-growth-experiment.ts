"use client";

import {
	growthExperimentVariant,
	type GrowthExperimentId,
	type GrowthExperimentVariant,
} from "@repo/config/growth-experiments";
import { trackBrowserGrowthEvent } from "@repo/utils/lib/growth-analytics-browser";
import {
	hasGrowthAnalyticsConsent,
	readGrowthAnalyticsSessionHash,
} from "@repo/utils/lib/growth-analytics-cookie";
import { useCallback, useEffect, useState } from "react";

import { useCookieConsent } from "./cookie-consent";

/** No new cookie. SSR is the existing experience; explicit choices always win. */
export function useGrowthExperiment(id: GrowthExperimentId, eligible = true) {
	const { analyticsAllowed } = useCookieConsent();
	const [assignment, setAssignment] = useState<{
		hash: string;
		variant: GrowthExperimentVariant;
	}>();
	const [target, setTarget] = useState<HTMLElement | null>(null);
	useEffect(() => {
		let active = true;
		if (analyticsAllowed && eligible) {
			void import("@repo/utils/lib/growth-analytics")
				.then(async (module) => {
					const hash = await module.getOrCreateBrowserGrowthAnalyticsSessionHash();
					if (active && hash && hasGrowthAnalyticsConsent(document.cookie))
						setAssignment({ hash, variant: growthExperimentVariant(id, hash) });
				})
				.catch(() => undefined);
		}
		return () => {
			active = false;
		};
	}, [analyticsAllowed, eligible, id]);
	const active = analyticsAllowed && eligible ? assignment : undefined;
	const observe = useCallback(
		(name: "experiment_exposed" | "experiment_clicked") => {
			if (
				!active ||
				!hasGrowthAnalyticsConsent(document.cookie) ||
				readGrowthAnalyticsSessionHash(document.cookie) !== active.hash
			)
				return;
			const event = {
				name,
				properties: {
					experiment: { experimentId: id, variant: active.variant },
				},
			};
			// A click also proves exposure. The report handles either arrival order.
			void trackBrowserGrowthEvent(
				event,
				name === "experiment_exposed" ? { dedupeKey: `${id}:${active.hash}:exposure` } : undefined,
			);
		},
		[active, id],
	);
	useEffect(() => {
		if (!target || !active || typeof IntersectionObserver === "undefined") return;
		let visible = false;
		const record = () => {
			if (visible && document.visibilityState === "visible") observe("experiment_exposed");
		};
		const observer = new IntersectionObserver(
			([entry]) => {
				visible = Boolean(entry?.isIntersecting);
				record();
			},
			{ threshold: 0.01 },
		);
		observer.observe(target);
		document.addEventListener("visibilitychange", record);
		return () => {
			observer.disconnect();
			document.removeEventListener("visibilitychange", record);
		};
	}, [active, observe, target]);
	return {
		variant: eligible ? assignment?.variant : undefined,
		exposureRef: setTarget,
		trackClick: () => observe("experiment_clicked"),
	};
}
