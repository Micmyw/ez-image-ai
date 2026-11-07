import { describe, expect, it } from "vitest";

import {
	sourceTemplateDisplayCredits,
	sourceTemplatePriceKey,
} from "./video-template-display-pricing";
import { sourceTemplateDefaults } from "./video-template-library";

describe("template display pricing", () => {
	it("matches all charged choices while scene and personal text remain price-neutral", () => {
		const choices = sourceTemplateDefaults("original-rap");
		const pricing = { version: 1, creditsByOptions: { [sourceTemplatePriceKey(choices)]: "123" } };
		expect(
			sourceTemplateDisplayCredits(pricing, {
				...choices,
				direction: "New lyrics",
				stageId: "neon-rap",
			}),
		).toBe("123");
		for (const patch of [
			{ tier: "pro" },
			{ preset: "solo" },
			{ durationSeconds: 5 },
			{ resolution: "2K" },
			{ aspectRatio: "16:9" },
		] as const)
			expect(sourceTemplateDisplayCredits(pricing, { ...choices, ...patch })).toBeNull();
		expect(sourceTemplateDisplayCredits(null, choices)).toBeNull();
	});
});
