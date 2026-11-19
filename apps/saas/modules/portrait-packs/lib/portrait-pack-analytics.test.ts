import { growthAnalyticsPath, publicAnalyticsPath } from "@repo/utils/lib/analytics-page";
import {
	createGrowthAnalyticsDispatcher,
	growthAnalyticsEventSchema,
} from "@repo/utils/lib/growth-analytics";
import { describe, expect, it } from "vitest";

const impression = {
	name: "portrait_pack_observed",
	properties: {
		portraitPack: { placement: "homepage", cta: "invitation", stage: "impression" },
	},
};

describe("portrait pack analytics", () => {
	it("allows a bounded impression or draw intent, not arbitrary private data", () => {
		expect(growthAnalyticsEventSchema.safeParse(impression).success).toBe(true);
		const draw = { placement: "public-page", cta: "draw", stage: "clicked" };
		for (const [value, success] of [
			[draw, true],
			[{ ...draw, cta: "invitation" }, false],
			[{ ...draw, placement: "user@example.com" }, false],
			[{ ...draw, card: "noir-studio" }, false],
			[{ ...draw, prompt: "secret" }, false],
		] as const) {
			expect(
				growthAnalyticsEventSchema.safeParse({
					...impression,
					properties: { portraitPack: value },
				}).success,
			).toBe(success);
		}
		expect(growthAnalyticsEventSchema.safeParse({ name: impression.name }).success).toBe(false);
		expect(
			growthAnalyticsEventSchema.safeParse({ ...impression, name: "page_viewed" }).success,
		).toBe(false);
	});

	it("does not dispatch before consent or repeat a successful measurement for the same CTA", async () => {
		let sent = 0;
		let allowed = false;
		const tracker = createGrowthAnalyticsDispatcher({
			hasConsent: () => allowed,
			send: () => {
				sent++;
			},
		});
		const options = { dedupeKey: "portrait-pack:homepage:invitation:impression" };
		expect(await tracker.track(impression, options)).toBe("blocked");
		allowed = true;
		expect(await tracker.track(impression, options)).toBe("sent");
		expect(await tracker.track(impression, options)).toBe("duplicate");
		expect(sent).toBe(1);
	});

	it("attributes the standalone draw to a safe path without enabling third-party analytics", () => {
		const url = new URL("https://ezimageai.com/portrait-packs?lang=de&private=identifier");
		expect(growthAnalyticsPath(url)).toBe("/portrait-packs");
		expect(publicAnalyticsPath(url)).toBeNull();
	});
});
