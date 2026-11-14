import { GENERATION_JOURNEY_OBSERVED } from "@repo/config/generation-journey";
import type { GrowthAnalyticsEvent } from "@repo/utils/lib/growth-analytics";

/** Project only validated scalar diagnostics; never persist the inbound properties object. */
export function growthDiagnosticProjection(
	event: GrowthAnalyticsEvent,
): Record<string, string | number | boolean> | null {
	const properties = event.properties;
	if (event.name === GENERATION_JOURNEY_OBSERVED && properties.journey) {
		return {
			...properties.journey,
			...(properties.task_hash ? { jobHash: properties.task_hash } : {}),
		};
	}
	const legacy = {
		...(properties.task_hash ? { task_hash: properties.task_hash } : {}),
		...(properties.latencyBucket ? { latencyBucket: properties.latencyBucket } : {}),
		...(properties.productKey ? { productKey: properties.productKey } : {}),
	};
	if (
		["homepage_idea_selected", "homepage_idea_preview_selected"].includes(event.name) &&
		properties.homepageIdea
	) {
		return {
			...legacy,
			homepageIdea: properties.homepageIdea,
			homepagePlacement: properties.homepagePlacement ?? "quick-start",
			...(properties.homepageIdea === "birthday-card" && properties.homepageVariant
				? { homepageVariant: properties.homepageVariant }
				: {}),
		};
	}
	const diagnostics = { ...legacy, ...(properties.experiment ?? properties.generation ?? {}) };
	return Object.keys(diagnostics).length ? diagnostics : null;
}
