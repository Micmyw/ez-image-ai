import {
	PORTRAIT_PACK_CTAS,
	PORTRAIT_PACK_OBSERVED,
	PORTRAIT_PACK_PLACEMENTS,
} from "@repo/config/portrait-packs";

import type { ConversionEvent } from "./conversion-funnel";

/** Input is already filtered by report period, source, device and non-internal browser. */
export function buildPortraitPackReport(events: ConversionEvent[]) {
	const observations = events.filter(({ name }) => name === PORTRAIT_PACK_OBSERVED);
	return PORTRAIT_PACK_PLACEMENTS.flatMap((placement) =>
		PORTRAIT_PACK_CTAS.filter((cta) => placement !== "public-page" || cta === "draw").map((cta) => {
			const exposed = new Set<string>();
			const clicked = new Set<string>();
			for (const { sessionHash, diagnostics } of observations) {
				if (diagnostics?.placement !== placement || diagnostics.cta !== cta) continue;
				if (diagnostics.stage === "impression") exposed.add(sessionHash);
				if (diagnostics.stage === "clicked") clicked.add(sessionHash);
			}
			return {
				placement,
				cta,
				exposed: exposed.size,
				clicked: [...clicked].filter((session) => exposed.has(session)).length,
			};
		}),
	);
}
