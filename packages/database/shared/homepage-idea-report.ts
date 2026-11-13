import {
	HOMEPAGE_QUICK_START_IDEAS,
	HOMEPAGE_SHOWCASE_IDEAS,
	type HomepageIdeaKey,
	type HomepageIdeaPlacement,
} from "@repo/config/homepage-ideas";

import type { ConversionEvent } from "./conversion-funnel";

/** Receives the conversion report's time/source/device-filtered, non-internal events. */
export function buildHomepageIdeaReport(events: ConversionEvent[]) {
	const rows = [
		...HOMEPAGE_SHOWCASE_IDEAS.map((idea) => ({ idea, placement: "showcase" as const })),
		...HOMEPAGE_QUICK_START_IDEAS.map((idea) => ({ idea, placement: "quick-start" as const })),
	];
	return rows.map(
		({ idea, placement }: { idea: HomepageIdeaKey; placement: HomepageIdeaPlacement }) => {
			const matching = events.filter(
				(event) =>
					event.diagnostics?.homepageIdea === idea &&
					(event.diagnostics.homepagePlacement ?? "quick-start") === placement,
			);
			const previews = matching.filter((event) => event.name === "homepage_idea_preview_selected");
			const creates = matching.filter((event) => event.name === "homepage_idea_selected");
			return {
				idea,
				placement,
				previewClicks: previews.length,
				previewVisitors: new Set(previews.map((event) => event.sessionHash)).size,
				createClicks: creates.length,
				createVisitors: new Set(creates.map((event) => event.sessionHash)).size,
			};
		},
	);
}
