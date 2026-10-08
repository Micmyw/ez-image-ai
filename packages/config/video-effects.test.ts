import { describe, expect, it } from "vitest";

import {
	HOTEL_LOBBY_PUBLIC_EFFECT,
	videoEffectCreateSchema,
	videoEffectRequestSchema,
} from "./video-effects";

const request = {
	effectId: "hotel-lobby-duo",
	presetKey: "standard",
	inputs: { leftAssetId: "left", rightAssetId: "right" },
};
describe("strict public duo template contract", () => {
	it("normalizes explicit five seconds without changing legacy fingerprints and rejects unsupported durations", () => {
		expect(videoEffectRequestSchema.parse({ ...request, duration: 5 })).toEqual(
			videoEffectRequestSchema.parse(request),
		);
		expect(videoEffectRequestSchema.parse({ ...request, duration: 10 }).duration).toBe(10);
		for (const duration of [0, 4, 6, 9, 12, "10", true, null])
			expect(videoEffectRequestSchema.safeParse({ ...request, duration }).success).toBe(false);
		expect(
			videoEffectRequestSchema.safeParse({
				...request,
				effectId: "rumpelstiltskin-solo",
				duration: 10,
				inputs: { leftAssetId: "one", rightAssetId: "one" },
			}).success,
		).toBe(false);
	});
	it("retains both ordered roles and permits one asset in both positions", () => {
		expect(videoEffectRequestSchema.parse(request).inputs).toEqual(request.inputs);
		const swapped = videoEffectRequestSchema.parse({
			...request,
			inputs: { leftAssetId: "right", rightAssetId: "left" },
		});
		expect(JSON.stringify(swapped)).not.toBe(
			JSON.stringify(videoEffectRequestSchema.parse(request)),
		);
		expect(
			videoEffectRequestSchema.safeParse({
				...request,
				inputs: { leftAssetId: "same", rightAssetId: "same" },
			}).success,
		).toBe(true);
	});
	it.each([
		"provider",
		"model",
		"productKey",
		"systemPrompt",
		"assetUrl",
		"callbackUrl",
		"credits",
		"skipModeration",
		"ownerId",
		"prompt",
		"duration",
		"sound",
	])("rejects client override %s at every request boundary", (key) => {
		expect(videoEffectRequestSchema.safeParse({ ...request, [key]: "override" }).success).toBe(
			false,
		);
		expect(
			videoEffectRequestSchema.safeParse({
				...request,
				inputs: { ...request.inputs, [key]: "override" },
			}).success,
		).toBe(false);
		expect(
			videoEffectCreateSchema.safeParse({
				quoteId: "quote",
				idempotencyKey: "stable-key",
				request,
				[key]: "override",
			}).success,
		).toBe(false);
	});
	it("does not accept alternate effects, presets or incomplete roles", () => {
		for (const value of [
			{ ...request, effectId: "unknown" },
			{ ...request, presetKey: "premium" },
			{ ...request, inputs: { leftAssetId: "left" } },
			{ ...request, inputs: { ...request.inputs, rightAssetId: "" } },
		])
			expect(videoEffectRequestSchema.safeParse(value).success).toBe(false);
	});
	it("requires quote identity and stable confirmation identity without public execution details", () => {
		expect(
			videoEffectCreateSchema.safeParse({ quoteId: "quote", idempotencyKey: "stable-key", request })
				.success,
		).toBe(true);
		expect(videoEffectCreateSchema.safeParse({ request }).success).toBe(false);
		expect(
			videoEffectCreateSchema.safeParse({
				quoteId: "quote",
				idempotencyKey: "x".repeat(128),
				request,
			}).success,
		).toBe(true);
		expect(
			videoEffectCreateSchema.safeParse({
				quoteId: "quote",
				idempotencyKey: "x".repeat(129),
				request,
			}).success,
		).toBe(false);
		const publicJson = JSON.stringify(HOTEL_LOBBY_PUBLIC_EFFECT).toLowerCase();
		for (const internal of [
			"seedance",
			"banana",
			"kie",
			"prompt",
			"productkey",
			"pricingbasis",
			"provider",
		])
			expect(publicJson).not.toContain(internal);
	});
});
