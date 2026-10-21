import type { FirstTouchAttribution } from "./acquisition-attribution";
import { collectFirstTouchAttribution } from "./acquisition-attribution-core";

let entry: FirstTouchAttribution | undefined;
export function captureConversionEntry() {
	if (typeof window !== "undefined" && !entry)
		entry = collectFirstTouchAttribution(window.location.href, document.referrer);
	return entry;
}
