import { describe, expect, it } from "vitest";

import { sourceHotelTemplateFixture } from "./test-support/source-hotel-template";
import {
	sourceTemplateProvisionSchema,
	sourceTemplateInternalRequestSchema,
	isProviderOwnedSourceTemplate,
} from "./video-template-execution.server";
import {
	sourceTemplateDefaults,
	sourceTemplateOptionSets,
	type SourceTemplateChoices,
} from "./video-template-library";

describe("source template complete price provisioning", () => {
	it("allows null prompt/duration only for the immutable original hosted Hotel body", () => {
		const request = sourceHotelTemplateFixture();
		expect(sourceTemplateInternalRequestSchema.parse(request)).toEqual(request);
		expect(isProviderOwnedSourceTemplate(request)).toBe(true);
		for (const patch of [
			{ executionContract: undefined },
			{ executionContract: "prompt" },
			{ prompt: "fabricated" },
			{ endpoint: "other-template" },
			{ body: {} },
			{ body: { ...request.sourceTemplate.transport.body, model: "invented" } },
			{
				body: {
					...request.sourceTemplate.transport.body,
					input: { ...request.sourceTemplate.transport.body.input, duration_seconds: 15 },
				},
			},
		]) {
			const changed = {
				...request,
				sourceTemplate: {
					...request.sourceTemplate,
					transport: { ...request.sourceTemplate.transport, ...patch },
				},
			};
			expect(sourceTemplateInternalRequestSchema.safeParse(changed).success).toBe(false);
		}
		expect(
			isProviderOwnedSourceTemplate({
				...request,
				sourceTemplate: { ...request.sourceTemplate, templateKey: "original-rap" },
			}),
		).toBe(false);
	});
	it.each(["original-rap", "spin-me-round"] as const)(
		"accepts every advertised exact %s pricing tuple",
		(key) => {
			const defaults = sourceTemplateDefaults(key);
			const sets = sourceTemplateOptionSets(key, defaults);
			const prices = [];
			for (const tier of sets.tiers)
				for (const preset of sets.presets) {
					const options: SourceTemplateChoices = { ...defaults, tier, preset };
					const selected = sourceTemplateOptionSets(key, options);
					for (const durationSeconds of selected.durations)
						for (const resolution of selected.resolutions)
							for (const aspectRatio of selected.ratios)
								prices.push({
									options: { tier, preset, durationSeconds, resolution, aspectRatio },
									credits: "1",
									providerCostMicros: "1",
									moderationCostMicros: "1",
									pricingVersion: "fixture-only",
									pricingBasis: "SYNTHETIC TEST ONLY",
								});
				}
			expect(prices.length).toBeGreaterThan(200);
			expect(new Set(prices.map((price) => JSON.stringify(price.options))).size).toBe(
				prices.length,
			);
			expect(
				sourceTemplateProvisionSchema.parse({
					version: "test-only",
					enabled: false,
					access: "internal",
					sourceConfig: {},
					references: [],
					prices,
				}).prices,
			).toHaveLength(prices.length);
		},
	);
});
