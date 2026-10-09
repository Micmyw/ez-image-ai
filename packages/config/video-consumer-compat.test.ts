import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
	VIDEO_MODEL_CATALOG,
	VIDEO_MODEL_CATALOG_VERSION,
	videoModelInputSchema,
	videoModelReceiptInputSchema,
} from "./video-models";
import {
	videoOutputConstraints,
	videoOutputSpecificationFailure,
	videoResolutionPixelContract,
} from "./video-output";
import { VIDEO_SUPPLIER_PRICE_VERSION, videoSupplierCostMicros } from "./video-pricing.server";
import { videoV1InputSchema, videoV1ReceiptInputSchema } from "./video-v1";

const request = {
	productKey: "video-veo-3-1",
	mode: "text-to-video" as const,
	prompt: "A sailboat on a lake",
	duration: 4,
	resolution: "1080p",
	aspectRatio: "16:9",
	sound: true,
};
const tiers = ["lite", "fast", "quality"] as const;
const future = (extra: Record<string, unknown> = {}) => ({
	...request,
	veoTier: "lite",
	modelContractVersion: "video-models-2026-10-08.1",
	resolutionPolicy: { schemaVersion: 1, kind: "minimum-short-edge", minimumShortEdge: 1080 },
	...extra,
});

describe("Veo activation after consumer compatibility", () => {
	it("activates the approved versions while preserving every other model's groups/defaults", () => {
		expect(VIDEO_MODEL_CATALOG_VERSION).toBe("video-models-2026-10-08.1");
		expect(VIDEO_SUPPLIER_PRICE_VERSION).toBe("kie-public-2026-10-08.1");
		// Independently read from the released 7c29ff8c bridge; only generic Veo changes.
		expect(
			createHash("sha256")
				.update(
					JSON.stringify(
						VIDEO_MODEL_CATALOG.filter((model) => model.productKey !== "video-veo-3-1"),
					),
				)
				.digest("hex"),
		).toBe("909b813acc1bec17638de6e11d74363c034927e2285ba523bb939e139a6d3320");
	});
	it.each(tiers)(
		"reads a frozen %s receipt and admits only an explicitly priced new tier",
		(veoTier) => {
			const receipt = { ...request, veoTier };
			expect(videoModelReceiptInputSchema.parse(receipt)).toEqual(receipt);
			expect(videoV1ReceiptInputSchema.parse(receipt)).toEqual(receipt);
			expect(videoModelInputSchema.parse(receipt)).toEqual(receipt);
			expect(videoV1InputSchema.parse(receipt)).toEqual(receipt);
			expect(videoSupplierCostMicros(receipt)).toBe(
				{ lite: 112_500n, fast: 187_500n, quality: 1_162_500n }[veoTier],
			);
		},
	);
	it("keeps missing-tier requests unpriced without adding a tier to historical receipts", () => {
		expect(videoModelInputSchema.safeParse(request).success).toBe(false);
		expect(() => videoSupplierCostMicros(request)).toThrow("VIDEO_MODEL_PRICE_UNAVAILABLE");
		expect(Object.keys(videoModelReceiptInputSchema.parse(request))).toEqual([
			"productKey",
			"mode",
			"prompt",
			"duration",
			"resolution",
			"aspectRatio",
			"sound",
		]);
	});
	it.each([
		{ veoTier: "pro" },
		{ veoTier: null },
		{ veoTier: "lite", productKey: "video-veo-3-1-fast" },
		{ veoTier: "fast", productKey: "video-kling-3" },
	])("rejects foreign or unknown receipt tiers %j", (extra) => {
		expect(videoModelReceiptInputSchema.safeParse({ ...request, ...extra }).success).toBe(false);
	});
	it.each(tiers)(
		"retains the frozen %s advisory output floor for landscape, portrait and Auto",
		(veoTier) => {
			for (const [resolution, floor] of [
				["720p", 720],
				["1080p", 1080],
				["4k", 2160],
			] as const) {
				for (const aspectRatio of ["16:9", "9:16", "source"]) {
					const constraints = videoOutputConstraints(
						future({
							veoTier,
							resolution,
							aspectRatio,
							resolutionPolicy: {
								schemaVersion: 1,
								kind: "minimum-short-edge",
								minimumShortEdge: floor,
							},
						}),
					);
					expect(videoResolutionPixelContract(constraints)).toBe("APP_MINIMUM");
					const pixels = (edge: number) => ({
						durationMillis: 4000,
						videoTracks: 1 as const,
						audioTracks: 0,
						width: aspectRatio === "9:16" ? edge : Math.round((edge * 16) / 9),
						height: aspectRatio === "9:16" ? Math.round((edge * 16) / 9) : edge,
					});
					expect(videoOutputSpecificationFailure(pixels(floor - 1), constraints)).toBeNull();
					expect(videoOutputSpecificationFailure(pixels(floor), constraints)).toBeNull();
					expect(videoOutputSpecificationFailure(pixels(floor + 18), constraints)).toBeNull();
				}
			}
		},
	);
	it("does not retroactively impose minimums on old generic or dedicated Fast jobs", () => {
		for (const productKey of ["video-veo-3-1", "video-veo-3-1-fast"]) {
			const constraints = videoOutputConstraints({ ...request, productKey, resolution: "4k" });
			expect(videoResolutionPixelContract(constraints)).toBe("NOT_VERIFIED");
			expect(
				videoOutputSpecificationFailure(
					{ durationMillis: 4000, width: 1280, height: 720, videoTracks: 1, audioTracks: 0 },
					constraints,
				),
			).toBeNull();
		}
	});
	it.each([
		{ resolutionPolicy: undefined },
		{ resolutionPolicy: null },
		{ resolutionPolicy: { schemaVersion: 1, kind: "minimum-short-edge", minimumShortEdge: 720 } },
		{ resolutionPolicy: { schemaVersion: 2, kind: "minimum-short-edge", minimumShortEdge: 1080 } },
		{
			resolutionPolicy: {
				schemaVersion: 1,
				kind: "minimum-short-edge",
				minimumShortEdge: 1080,
				extra: true,
			},
		},
		{ modelContractVersion: "video-models-2026-10-04.2" },
		{ modelContractVersion: "video-models-2099-01-01.1" },
		{ productKey: "video-veo-3-1-fast" },
		{ productKey: undefined },
		{ veoTier: undefined },
		{ veoTier: "pro" },
	])("rejects missing, foreign or changed frozen output policy %j", (extra) => {
		expect(() => videoOutputConstraints(future(extra))).toThrow("VIDEO_RESOLUTION_POLICY_INVALID");
	});
});
