import { describe, expect, it } from "vitest";

import {
	createVideoEffectTemplateSnapshot,
	parseVideoEffectTemplateSnapshot,
	readVideoEffectPricingDisplay,
} from "./video-effects.server";
import { videoOutputConstraints } from "./video-output";

describe("Seedance Mini template migration", () => {
	for (const effectId of ["hotel-lobby-duo", "raindance-solo", "raindance-duo"] as const) {
		it.each([5, 10] as const)(
			`freezes new ${effectId} %ss orders as a distinct Mini contract`,
			(duration) => {
				const template = createVideoEffectTemplateSnapshot({
					effectId,
					presetKey: "standard",
					...(duration === 10 ? { duration } : {}),
					inputs: { leftAssetId: "one", rightAssetId: "one" },
				});
				expect(template.schemaVersion).toBe(4);
				expect(template.templateVersion).toBe(
					`${effectId === "hotel-lobby-duo" ? "hotel-lobby-duo" : "raindance"}-mini-${duration === 10 ? "10s-" : ""}2026-10-20.1`,
				);
				expect(template.video).toMatchObject({
					productKey: "video-seedance-2-mini",
					mode: "image-to-video",
					duration,
					resolution: "720p",
					aspectRatio: "9:16",
					sound: false,
					fixedLens: false,
				});
				expect(template.video.prompt).not.toMatch(/fixed camera/i);
				expect(template.video.promptVersion).toContain("mini");
				expect(template.output.durationSeconds).toBe(duration);
				expect(parseVideoEffectTemplateSnapshot(template)).toEqual(template);
				expect(() =>
					parseVideoEffectTemplateSnapshot({
						...template,
						video: { ...template.video, resolution: "1080p" },
					}),
				).toThrow();
				expect(() =>
					parseVideoEffectTemplateSnapshot({
						...template,
						video: { ...template.video, fixedLens: true },
					}),
				).toThrow();
			},
		);
	}

	it.each(
		(["hotel-lobby-duo", "raindance-solo", "raindance-duo"] as const).flatMap((effectId) =>
			([5, 10] as const).map((duration) => ({ effectId, duration })),
		),
	)(
		"keeps frozen historical $effectId $duration second Seedance 1.5 receipts unchanged",
		({ effectId, duration }) => {
			const template = createVideoEffectTemplateSnapshot({
				effectId,
				presetKey: "standard",
				...(duration === 10 ? { duration } : {}),
				inputs: { leftAssetId: "one", rightAssetId: "one" },
			});
			const frozen = {
				...template,
				schemaVersion: duration === 10 ? 3 : 1,
				templateVersion:
					effectId === "hotel-lobby-duo"
						? duration === 10
							? "hotel-lobby-duo-10s-2026-10-08.1"
							: "hotel-lobby-duo-2026-10-05.1"
						: duration === 10
							? "raindance-10s-2026-10-08.1"
							: "raindance-2026-10-07.1",
				video: {
					...template.video,
					productKey: "video-seedance-1-5-pro",
					fixedLens: true,
					prompt: "The exact historical prompt remains frozen.",
					promptVersion: "historical-motion-version",
				},
			};
			expect(parseVideoEffectTemplateSnapshot(frozen)).toEqual(frozen);
			expect(
				videoOutputConstraints({
					...frozen.video,
					requestKind: "template-video",
					videoEffectTemplate: frozen,
				}),
			).toMatchObject({
				productKey: "video-seedance-1-5-pro",
				durationSeconds: duration,
			});
			expect(() =>
				parseVideoEffectTemplateSnapshot({
					...frozen,
					video: { ...frozen.video, productKey: "video-seedance-2-mini" },
				}),
			).toThrow();
		},
	);
	it("keeps the accepted legacy annual retail receipt readable at its original price", () => {
		const display = {
			policyVersion: "video-effect-retail-2026-10-08.1",
			audience: "annual",
			credits: "101",
			standardCredits: "116",
			annualCredits: "101",
			savedCredits: "15",
			annualSavingsCredits: "15",
		};
		expect(readVideoEffectPricingDisplay({ retail: { display } })).toEqual(display);
	});
});
