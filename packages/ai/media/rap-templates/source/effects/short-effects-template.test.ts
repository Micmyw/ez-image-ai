import { describe, expect, it } from "vitest";

import { GREEN_BOOTH_PRIVATE_CONFIG_KEY } from "../green-booth-template";
import { PET_EFFECT_TEMPLATE_KEYS } from "../pet-effect-template";
import {
	SHORT_EFFECT_IDS,
	SHORT_EFFECTS,
	type ShortEffectId,
	type ShortEffectInput,
} from "../short-effects";
import { greenBoothFixture } from "./__fixtures__/green-booth";
import { petEffectFixture } from "./__fixtures__/pet";
import {
	readShortEffectTemplate,
	shortEffectBody,
	shortEffectTemplateReady,
} from "./short-effects-template.server";

const key = (id: ShortEffectId) =>
	id === "green-booth-freestyle-ai" ? GREEN_BOOTH_PRIVATE_CONFIG_KEY : PET_EFFECT_TEMPLATE_KEYS[id];
const fixture = (id: ShortEffectId) =>
	id === "green-booth-freestyle-ai" ? greenBoothFixture : petEffectFixture(id);
const configs = (id: ShortEffectId, override: Record<string, unknown> = {}) => ({
	[key(id)]: JSON.stringify({ ...fixture(id), ...override }),
	[SHORT_EFFECTS[id].enabledKey]: "true",
});
function input(id: ShortEffectId): ShortEffectInput {
	const effect = SHORT_EFFECTS[id];
	return {
		templateId: id,
		revision: effect.revision,
		preset: effect.preset,
		duration: effect.duration,
		resolution: effect.resolution,
		aspectRatio: effect.aspectRatio,
		imageUrl: "https://media.example.com/identity-a.png",
		...(effect.preset === "duo"
			? { secondImageUrl: "https://media.example.com/identity-b.png" }
			: {}),
		expectedCredits: effect.defaultCredits,
		idempotencyKey: "550e8400-e29b-41d4-a716-446655440000",
		consentVersion: "short-effects-v1",
	} as ShortEffectInput;
}
describe("backend short effect contracts", () => {
	it.each(SHORT_EFFECT_IDS)("requires stored verified material for %s even when enabled", (id) => {
		for (const config of [{}, { [SHORT_EFFECTS[id].enabledKey]: "true" }]) {
			expect(shortEffectTemplateReady(id, config)).toBe(false);
			expect(() => shortEffectBody(input(id), config)).toThrow("EFFECT_NOT_READY");
		}
	});
	it.each(SHORT_EFFECT_IDS)("orders identities, references and audio for %s", (id) => {
		const saved = fixture(id);
		const request = input(id);
		expect(shortEffectTemplateReady(id, configs(id))).toBe(true);
		const body = shortEffectBody(
			request,
			configs(id),
			"https://app.example.com/callback?token=fixture",
		);
		expect(body).toEqual({
			model: "minimax-h3/reference-to-video",
			callBackUrl: "https://app.example.com/callback?token=fixture",
			input: {
				prompt: saved.prompt,
				reference_image_urls: [
					request.imageUrl,
					...(request.secondImageUrl ? [request.secondImageUrl] : []),
					saved.sceneImageUrl,
					saved.poseImageUrl,
					...(id === "green-booth-freestyle-ai" ? [saved.endPoseImageUrl] : []),
				],
				reference_audio_urls: [saved.referenceAudioUrl],
				duration: request.duration,
				aspect_ratio: request.aspectRatio,
				resolution: "768P",
			},
		});
		expect(body.input).not.toHaveProperty("reference_video_urls");
		expect(body.input).not.toHaveProperty("documents");
	});
	it.each(["", "false", "1", "yes"])("requires explicit true, received %s", (flag) => {
		const id = "kung-fu-cat-ai";
		expect(
			shortEffectTemplateReady(id, {
				...configs(id),
				[SHORT_EFFECTS[id].enabledKey]: flag,
			}),
		).toBe(false);
	});
	it.each([
		{ enabled: false },
		{ assetsVerified: false },
		{ assetsVerified: undefined },
		{ prompt: "" },
		{ prompt: "x".repeat(7001) },
		{ prompt: "__REPLACE_WITH_APPROVED_PROMPT__" },
		{ prompt: "TODO: add approved prompt" },
		{ prompt: "Use {{PRIVATE_PROMPT}}" },
		{ sceneImageUrl: "http://localhost/private.png" },
		{ sceneImageUrl: "https://127.0.0.1/private.png" },
		{ sceneImageUrl: "https://user:pass@media.example.com/scene.png" },
		{ poseImageUrl: "https://media.example.com/PLACEHOLDER-pose.png" },
		{
			poseImageUrl: "https://media.example.com/%5F%5FREPLACE_WITH_POSE%5F%5F.png",
		},
		{ referenceAudioUrl: "https://media.example.com/TBD.wav" },
		{ referenceAudioUrl: "../audio.wav" },
		{ referenceAudioUrl: "https://example.invalid/audio.wav" },
		{ referenceAudioUrl: "//media.example.com/audio.wav" },
		{ rightsManifest: "" },
		{ rightsManifest: "__REPLACE_WITH_RIGHTS_RECORD__" },
		{ endPoseImageUrl: "https://media.example.com/unexpected.png" },
		{ reference_video_urls: ["https://media.example.com/private.mp4"] },
		{ poseImageUrl: petEffectFixture("kung-fu-cat-ai").previewUrl },
		{ referenceAudioUrl: petEffectFixture("kung-fu-cat-ai").sceneImageUrl },
	])("blocks invalid, unresolved and overlapping material %#", (override) => {
		const id = "kung-fu-cat-ai";
		expect(shortEffectTemplateReady(id, configs(id, override))).toBe(false);
		expect(() => shortEffectBody(input(id), configs(id, override))).toThrow("EFFECT_NOT_READY");
	});
	it("uses backend revisions and ignores the retired JSON asset base", () => {
		const id = "kung-fu-cat-ai";
		const config = {
			...configs(id, {
				revision: "edited-backend-revision",
				prompt: "Updated private pet prompt",
			}),
			short_effect_asset_base_url: "https://obsolete.invalid",
		};
		expect(shortEffectTemplateReady(id, config)).toBe(true);
		expect(() => shortEffectBody(input(id), config)).toThrow("EFFECT_REVISION_CHANGED");
		expect(
			shortEffectBody({ ...input(id), revision: "edited-backend-revision" }, config).input.prompt,
		).toBe("Updated private pet prompt");
	});
	it("keeps disabled materials readable for review", () => {
		const id = "paws-at-you-ai";
		const config = configs(id, { enabled: false });
		expect(readShortEffectTemplate(id, config).previewUrl).toBe(fixture(id).previewUrl);
		expect(shortEffectTemplateReady(id, config)).toBe(false);
	});
	it("rejects stale price and unknown IDs", () => {
		const id = "kung-fu-cat-ai";
		expect(() => shortEffectBody({ ...input(id), expectedCredits: 1 }, configs(id))).toThrow(
			"EFFECT_QUOTE_CHANGED",
		);
		expect(
			shortEffectTemplateReady(id, {
				...configs(id),
				short_kung_fu_cat_768p_credits: "0",
			}),
		).toBe(false);
		expect(shortEffectTemplateReady("__proto__" as ShortEffectId, configs(id))).toBe(false);
	});
});
