import { sanitizeFirstTouchAttribution } from "./acquisition-attribution";
import { publicAnalyticsPath } from "./analytics-page";
import { captureConversionEntry } from "./conversion-entry";
import type { GrowthAnalyticsEvent } from "./growth-analytics";
import {
	hasGrowthAnalyticsConsent,
	readGrowthAnalyticsSessionHash,
} from "./growth-analytics-cookie";

export async function sendFirstPartyGrowthEvent(event: GrowthAnalyticsEvent): Promise<void> {
	if (typeof window === "undefined" || !hasGrowthAnalyticsConsent(document.cookie)) return;
	const sessionHash = readGrowthAnalyticsSessionHash(document.cookie);
	if (!sessionHash || sessionHash !== event.properties.anonymousSessionHash) return;
	let firstTouch = captureConversionEntry();
	try {
		const value = document.cookie
			.split(";")
			.map((part) => part.trim())
			.find((part) => part.startsWith("ezimage_first_touch="))
			?.split("=")
			.slice(1)
			.join("=");
		if (value)
			firstTouch =
				sanitizeFirstTouchAttribution(
					JSON.parse(decodeURIComponent(value)),
					window.location.origin,
				) ?? firstTouch;
	} catch {
		/* Optional cookies can be unavailable. */
	}
	// Same-origin observations are best effort and never affect a product action.
	const response = await fetch("/api/analytics/events", {
		method: "POST",
		credentials: "same-origin",
		keepalive: true,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			id: crypto.randomUUID(),
			event,
			firstTouch,
			path: publicAnalyticsPath(new URL(window.location.href)),
		}),
	});
	if (!response.ok || (await response.json())?.accepted !== true)
		throw new Error("ANALYTICS_OBSERVATION_NOT_ACCEPTED");
}
