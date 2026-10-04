import { createBrowserGrowthAnalyticsDispatcher, growthAnalyticsEventSchema } from "@repo/utils";
import { describe, expect, it, vi } from "vitest";

const event = {
	name: "video_effect_accepted_observed",
	properties: {
		effect_id: "hotel-lobby-duo",
		preset_id: "standard",
		preset_version: 1,
		internal_source: "effect",
		entry_path: "/video-effects/hotel-lobby-ai",
	},
};
describe("template analytics use the existing consent boundary", () => {
	it("rejects provider, signed URL and photo properties", () => {
		expect(growthAnalyticsEventSchema.safeParse(event).success).toBe(true);
		for (const property of ["model", "prompt", "previewUrl", "photo", "filename", "providerCost"])
			expect(
				growthAnalyticsEventSchema.safeParse({
					...event,
					properties: { ...event.properties, [property]: "private" },
				}).success,
			).toBe(false);
	});
	it("does not dispatch without consent and deduplicates actual receipt events", async () => {
		let cookie = "consent=false";
		const dispatch = vi.fn();
		const dispatcher = createBrowserGrowthAnalyticsDispatcher({
			getCookie: () => cookie,
			dispatch,
		});
		expect(await dispatcher.track(event, { dedupeKey: "accepted:job" })).toBe("blocked");
		expect(dispatch).not.toHaveBeenCalled();
		cookie = "consent=true";
		expect(await dispatcher.track(event, { dedupeKey: "accepted:job" })).toBe("sent");
		expect(await dispatcher.track(event, { dedupeKey: "accepted:job" })).toBe("duplicate");
		expect(dispatch).toHaveBeenCalledTimes(1);
	});
});
