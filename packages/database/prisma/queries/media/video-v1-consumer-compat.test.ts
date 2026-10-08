import { describe, expect, it, vi } from "vitest";

import { findExistingVideoAdmission, fingerprintVideoRequest } from "./video-v1";

const request = {
	productKey: "video-veo-3-1",
	mode: "text-to-video" as const,
	prompt: "A sailboat on a lake",
	duration: 4,
	resolution: "1080p",
	aspectRatio: "16:9",
	sound: true,
};
describe("consumer bridge receipt identity", () => {
	it("preserves fixed pre-bridge text, image and original V1 fingerprint vectors", () => {
		expect(fingerprintVideoRequest("owner", request)).toBe(
			"0503daba69af3541b92de0b4280cd26fe0b67178727881040679cf128d288fb0",
		);
		expect(
			fingerprintVideoRequest("owner", {
				...request,
				mode: "image-to-video",
				aspectRatio: "source",
				inputAssetId: "sealed",
			}),
		).toBe("f0aa7a8851d954a48fc8634aec5a5f56db6b0c8450060cb468d014c4788f1f40");
		expect(
			fingerprintVideoRequest("owner", {
				mode: "text-to-video",
				prompt: request.prompt,
				duration: 5,
				sound: false,
				aspectRatio: "16:9",
			}),
		).toBe("131631952ccb06e50b418aaf7939a6a2913ded621c2a2051d532163b8f745264");
	});
	it("keeps absent/lite/fast/quality identities distinct and owner-bound", () => {
		const values = [undefined, "lite", "fast", "quality"].map((veoTier) =>
			fingerprintVideoRequest("owner", { ...request, ...(veoTier ? { veoTier } : {}) } as never),
		);
		expect(new Set(values).size).toBe(4);
		expect(fingerprintVideoRequest("another-owner", request)).not.toBe(values[0]);
	});
	it.each([undefined, "lite", "fast", "quality"])(
		"reconstructs the exact already accepted %s snapshot for replay",
		async (veoTier) => {
			const receipt = { ...request, ...(veoTier ? { veoTier } : {}) };
			const job = {
				id: "accepted-job",
				executionEngine: "video-workflow-v1",
				videoExecution: {},
				reservation: {},
				inputSnapshot: {
					...receipt,
					schemaVersion: 1,
					modelContractVersion: veoTier ? "video-models-2026-10-08.1" : "video-models-2026-10-04.2",
				},
			};
			const tx = { generationJob: { findUnique: vi.fn(async () => job) } };
			expect(
				await findExistingVideoAdmission(
					{ ownerId: "owner", idempotencyKey: "accepted", request: receipt as never },
					tx as never,
				),
			).toBe(job);
			if (veoTier) {
				await expect(
					findExistingVideoAdmission(
						{ ownerId: "owner", idempotencyKey: "accepted", request },
						tx as never,
					),
				).rejects.toThrow("IDEMPOTENCY_CONFLICT");
				await expect(
					findExistingVideoAdmission(
						{
							ownerId: "owner",
							idempotencyKey: "accepted",
							request: { ...receipt, veoTier: veoTier === "lite" ? "quality" : "lite" } as never,
						},
						tx as never,
					),
				).rejects.toThrow("IDEMPOTENCY_CONFLICT");
			}
		},
	);
});
