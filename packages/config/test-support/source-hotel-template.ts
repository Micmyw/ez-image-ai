/** Synthetic immutable source contract for local tests; never evidence of provider behavior. */
export function sourceHotelTemplateFixture() {
	return {
		requestKind: "source-template-video" as const,
		productKey: "source-template:source-hotel-lobby",
		mode: "image-to-video" as const,
		prompt: null,
		duration: null,
		inputAssetId: "input-1",
		resolution: "768P",
		aspectRatio: "9:16",
		sound: true,
		sourceTemplate: {
			templateKey: "source-hotel-lobby" as const,
			version: "test-only-source-v1",
			provision: { id: "test-only-provision", version: 1 },
			request: {
				templateKey: "source-hotel-lobby" as const,
				options: { resolution: "768P", aspectRatio: "9:16" },
				inputs: [
					{ role: "performer-1" as const, assetId: "input-1" },
					{ role: "performer-2" as const, assetId: "input-2" },
				],
			},
			transport: {
				executionContract: "provider-owned-template" as const,
				provider: "seeapi" as const,
				modelId: "hotel-lobby-ai",
				endpoint: "hotel-lobby-ai",
				revision: "ezrapvideo-hotel-lobby-endpoint-v1",
				prompt: null,
				requiredAssetUrls: [],
				body: {
					provider: "seeapi",
					input: {
						reference_images: [
							"https://ezpic-template.example/user/performer-1",
							"https://ezpic-template.example/user/performer-2",
						],
						resolution: "768P",
						aspect_ratio: "9:16",
					},
				},
				output: { durationSeconds: null, resolution: "768P", aspectRatio: "9:16", sound: true },
			},
			references: [],
		},
	};
}
