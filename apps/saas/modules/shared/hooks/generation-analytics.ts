"use client";

import {
	generationDiagnosticsSchema,
	type GenerationDiagnostics,
} from "@repo/utils/lib/generation-diagnostics";
import { trackBrowserGrowthEvent } from "@repo/utils/lib/growth-analytics-browser";
import { useEffect, useRef } from "react";

import { useCookieConsent } from "./cookie-consent";

export function trackGenerationAction(value: GenerationDiagnostics) {
	const result = generationDiagnosticsSchema.safeParse(value);
	if (result.success)
		void trackBrowserGrowthEvent({
			name: "generation_action_observed",
			properties: { generation: result.data },
		});
}

/** Receives buckets and public options, never a prompt, file, account or task identifier. */
export function useGenerationAnalytics(value: GenerationDiagnostics, active = true) {
	const { analyticsAllowed } = useCookieConsent();
	const serialized = JSON.stringify(value);
	const previous = useRef<string | null>(null);
	useEffect(() => {
		if (!analyticsAllowed || !active) {
			previous.current = null;
			return;
		}
		if (serialized === previous.current) return;
		const timer = setTimeout(() => {
			const parsed = generationDiagnosticsSchema.safeParse(JSON.parse(serialized));
			if (!parsed.success) return;
			previous.current = serialized;
			void trackBrowserGrowthEvent({
				name: "generation_input_observed",
				properties: { generation: parsed.data },
			});
		}, 600);
		return () => clearTimeout(timer);
	}, [serialized, active, analyticsAllowed]);
}
