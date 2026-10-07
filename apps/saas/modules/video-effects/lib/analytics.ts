import { HOTEL_LOBBY_EFFECT_ID, type VideoEffectId } from "@repo/config/video-effects";
import { trackBrowserGrowthEvent } from "@repo/utils";

import { videoEffectPath } from "./paths";

type Event =
	| "view"
	| "sample_play"
	| "inputs_ready"
	| "quote_view"
	| "submit"
	| "accepted"
	| "ready"
	| "failed"
	| "held"
	| "download";
/** Reuses the consent-aware dispatcher and its sanitized external analytics transport.
 * Business state observations are emitted only after a server receipt/state response;
 * unique orders/outcomes are counted from durable business records, not these events.
 * Dedupe identities stay in session storage; they are never analytics properties. */
export async function recordVideoEffectEvent(
	event: Event,
	identity?: string,
	effectId: VideoEffectId = HOTEL_LOBBY_EFFECT_ID,
) {
	const key = identity ? `video-effect-event:${event}:${identity}` : undefined;
	try {
		if (key && sessionStorage.getItem(key) === "sent") return;
	} catch {
		/* Dispatcher still deduplicates within this page. */
	}
	const result = await trackBrowserGrowthEvent(
		{
			name: `video_effect_${event}${["accepted", "ready", "failed", "held"].includes(event) ? "_observed" : ""}`,
			properties: {
				effect_id: effectId,
				preset_id: "standard",
				preset_version: 1,
				internal_source: "effect",
				entry_path: videoEffectPath(effectId),
			},
		},
		key ? { dedupeKey: key } : undefined,
	);
	if (key && result === "sent") {
		try {
			sessionStorage.setItem(key, "sent");
		} catch {
			/* Optional duplicate suppression. */
		}
	}
}
