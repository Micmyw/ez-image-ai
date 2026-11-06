import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { SourceTemplateChoices, SourceTemplateKey } from "@repo/config/video-template-library";
import { describe, expect, it } from "vitest";

import { archivedSourceMaterials, prepareArchivedSourceTemplateConfig } from "./archive";
import { resolveSourceTemplateRequest } from "./contracts";
import effective from "./effective-source-prompts.json";
import originalConfigs from "./original-template-configs.json";
import manifest from "./source-manifest.json";
import { spinDancePrompt } from "./source/effects/spin-dance-template.server";
import bulin from "./source/effects/templates/bulin-h3-v1.json";
import { buildRapPrompt } from "./source/rap-prompt.server";

const portraits = [
	"https://private.example.com/identity-a.png",
	"https://private.example.com/identity-b.png",
	"https://private.example.com/identity-c.png",
];
/** Original effective prompt/config values, with test-only transport URLs. */
export const effectiveTestConfigs: Record<string, string> = Object.fromEntries(
	Object.entries(originalConfigs.templates).map(([key, template]) => [
		key,
		JSON.stringify(template, (_key, value: unknown) =>
			typeof value === "string" && value.startsWith("source-asset:")
				? `https://private.example.com/${value.slice(13)}`
				: typeof value === "string" && value.startsWith("source-metadata:")
					? `https://public.example.com/${value.slice(16).replaceAll(":", "/")}`
					: value,
		),
	]),
);
Object.assign(effectiveTestConfigs, originalConfigs.sourceFlags);
function resolve(
	templateKey: SourceTemplateKey,
	options: SourceTemplateChoices = {},
	count = 1,
	configs = effectiveTestConfigs,
) {
	return resolveSourceTemplateRequest({
		templateKey,
		options,
		userImageUrls: portraits.slice(0, count),
		configs,
	});
}

describe("source-preserved private execution", () => {
	it.each([
		["bulin-47", 1],
		["spin-me-round", 1],
		["58th-floor", 2],
		["green-booth-freestyle", 2],
		["kung-fu-cat", 1],
		["paws-at-you", 1],
	] as const)(
		"prepares %s offline with exact original private material identities",
		(key, count) => {
			const request = resolve(key, {}, count, prepareArchivedSourceTemplateConfig(key));
			const required = request.requiredAssetUrls.map((url) =>
				archivedSourceMaterials.find((asset) => asset.transportUrl === url),
			);
			expect(required.every(Boolean)).toBe(true);
			expect(
				request.requiredAssetUrls.every((url) => url.startsWith("https://ezpic-template.example/")),
			).toBe(true);
			const direct = resolve(key, {}, count);
			expect(request.prompt).toBe(direct.prompt);
			expect(request.modelId).toBe(direct.modelId);
			expect(request.output).toEqual(direct.output);
		},
	);
	it("preserves original JSON/document bytes and all staged original material hashes", () => {
		for (const file of manifest.files.filter((entry) => entry.copyMode === "verbatim"))
			expect(
				createHash("sha256")
					.update(readFileSync(new URL(file.targetPath, import.meta.url)))
					.digest("hex"),
			).toBe(file.sourceSha256);
		for (const asset of manifest.assets) {
			const bytes = readFileSync(new URL(asset.targetPath, import.meta.url));
			expect(bytes.length).toBe(asset.bytes);
			expect(createHash("sha256").update(bytes).digest("hex")).toBe(asset.sha256);
		}
		expect(manifest.effectiveConfiguration.materialBindings).toHaveLength(19);
	});
	it("preserves exact effective prompt bytes without claiming target verification", () => {
		for (const value of Object.values(effective)) {
			for (const [key, prompt] of Object.entries(value.prompts))
				expect(createHash("sha256").update(prompt).digest("hex")).toBe(
					(value.promptSha256 as Record<string, string>)[key],
				);
			expect(value.targetVerifiedAt).toBeNull();
		}
	});
	it.each(["orange-studio", "street-cypher", "neon-rap", "funny-rap"] as const)(
		"keeps exact original %s composition and native audio",
		(stageId) => {
			for (const locale of ["en", "zh"] as const)
				for (const count of [0, 1, 2]) {
					const request = resolve("original-rap", { stageId, locale }, count);
					expect(request.prompt).toBe(
						buildRapPrompt({
							composition: { stageId, locale },
							duration: 12,
							direction: "",
							aspectRatio: "9:16",
							photoCount: count,
						}),
					);
					expect(request.provider).toBe("seeapi");
					expect(request.endpoint).toBe(count ? "reference-to-video" : "text-to-video");
					expect(request.body.input).toHaveProperty("generate_audio", true);
				}
		},
	);
	it("uses the exact Bulin original prompt and user/scene/pose/audio order", () => {
		const request = resolve("bulin-47");
		expect(request.prompt).toBe(bulin.input.prompt);
		expect(request.body).toMatchObject({
			model: "seedance-2-mini",
			endpoint: "reference-to-video",
			input: {
				reference_images: [
					portraits[0],
					"https://ezairapvideo.com/effects/bulin-47/freestyle-v1/scene_clean.png",
					"https://ezairapvideo.com/effects/bulin-47/freestyle-v1/pose_left_arm_optional.png",
				],
				reference_audio: [
					"https://ezairapvideo.com/effects/bulin-47/freestyle-v1/reference_00-15s.wav",
				],
			},
		});
		expect(request.output).toEqual({
			durationSeconds: 15,
			resolution: "720p",
			aspectRatio: "9:16",
			sound: true,
		});
	});
	it("reads effective saved Bulin before the source default", () => {
		const base = resolve("bulin-47");
		const saved = {
			revision: "source-effective-v2",
			enabled: true,
			modelId: "seedance-2",
			resolution: "1080p",
			prompt: base.prompt,
			sceneImageUrl: "https://private.example.com/scene.png",
			poseImageUrl: "",
			referenceAudioUrl: "https://private.example.com/audio.wav",
			posterUrl: "",
			previewUrl: "",
			exampleSourceUrl: "",
		};
		const request = resolve("bulin-47", {}, 1, {
			bulin47_template_private_key: JSON.stringify(saved),
		});
		expect(request.modelId).toBe("seedance-2");
		expect(request.revision).toBe(saved.revision);
		expect(request.requiredAssetUrls).toEqual([saved.sceneImageUrl, saved.referenceAudioUrl]);
	});
	it.each(["solo", "duo", "trio"] as const)(
		"keeps exact dynamic Spin %s assembly and scene-first identity order",
		(preset) => {
			const count = { solo: 1, duo: 2, trio: 3 }[preset];
			const request = resolve(
				"spin-me-round",
				{ preset, sceneId: "retro-neon", durationSeconds: 8, aspectRatio: "1:1" },
				count,
			);
			expect(request.prompt).toBe(
				spinDancePrompt(preset, "retro-neon", { duration: 8, aspectRatio: "1:1" }),
			);
			expect(request.body.input).toHaveProperty("reference_images", [
				"https://ezairapvideo.com/effects/spin-me-round/retro-neon-v1.png",
				...portraits.slice(0, count),
			]);
		},
	);
	it.each(["solo", "duo", "person-pet"] as const)(
		"keeps the effective 58th %s prompt and H3 native contract",
		(preset) => {
			const request = resolve("58th-floor", { preset }, preset === "solo" ? 1 : 2);
			expect(request.prompt).toBe(effective.floor58_template_private_key.prompts[preset]);
			expect(request.modelId).toBe("minimax-h3/reference-to-video");
			expect(request.body.input).toHaveProperty("reference_image_urls", [
				...portraits.slice(0, preset === "solo" ? 1 : 2),
				...request.requiredAssetUrls.slice(0, 3),
			]);
		},
	);
	it.each([
		["green-booth-freestyle", "green_booth_template_private_key", 2, 10, "16:9"],
		["kung-fu-cat", "kung_fu_cat_template_private_key", 1, 9, "9:16"],
		["paws-at-you", "paws_at_you_template_private_key", 1, 6, "9:16"],
	] as const)(
		"uses actual effective %s, never the placeholder JSON",
		(key, configKey, count, durationSeconds, aspectRatio) => {
			const request = resolve(key, {}, count);
			expect(request.prompt).toBe(effective[configKey].prompts.default);
			expect(request.revision).toBe(effective[configKey].revision);
			expect(request.output).toEqual({
				durationSeconds,
				aspectRatio,
				resolution: "768P",
				sound: true,
			});
			expect(request.body.input).toHaveProperty("reference_image_urls", [
				...portraits.slice(0, count),
				...request.requiredAssetUrls.slice(0, -1),
			]);
			expect(() => resolve(key, {}, count, {})).toThrow();
		},
	);
	it("preserves the provider-owned Hotel Lobby endpoint without inventing duration or prompt", () => {
		const request = resolve("source-hotel-lobby", { resolution: "2K" }, 2);
		expect(request.endpoint).toBe("hotel-lobby-ai");
		expect(request.executionContract).toBe("provider-owned-template");
		expect(request.prompt).toBeNull();
		expect(request.output.durationSeconds).toBeNull();
		expect(request.body).toEqual({
			provider: "seeapi",
			input: { reference_images: portraits.slice(0, 2), resolution: "2K", aspect_ratio: "9:16" },
		});
	});
	it.each([
		["bulin-47", { durationSeconds: 10 }],
		["source-hotel-lobby", { durationSeconds: 15 }],
		["kung-fu-cat", { resolution: "2K" }],
		["green-booth-freestyle", { aspectRatio: "9:16" }],
		["58th-floor", { tier: "pro" }],
	] as const)("rejects generation-contract substitution for %s", (key, options) => {
		expect(() =>
			resolve(
				key,
				options,
				key === "green-booth-freestyle" || key === "source-hotel-lobby" ? 2 : 1,
			),
		).toThrow();
	});
});
