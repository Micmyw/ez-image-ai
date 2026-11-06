import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { archivedSourceMaterials, prepareArchivedSourceTemplateConfig } from "./archive";
import { resolveSourceTemplateRequest } from "./contracts";
import { flyingCarTemplateIds } from "./source/flyingcar/request";
import prompts from "./source/flyingcar/templates/prompts.json";
import { getVideoPrompt, getVideoPromptVersion } from "./source/flyingcar/video-prompt";
import { getVideoTemplate } from "./source/video-templates";
import {
	retrieveSourceTemplateRequest,
	submitSourceTemplateRequest,
	validateSourceKieH3Request,
} from "./transport";

const keys = Object.keys(flyingCarTemplateIds) as (keyof typeof flyingCarTemplateIds)[];
const userImageUrl = "https://private.example.com/subject.png";
const callbackUrl = "https://app.example.com/provider/callback";
const options = { apiKey: "fixture-key", idempotencyKey: "fixed_flyingcar_attempt" };

describe("exact source Flying Car generation contracts", () => {
	it("retains every raw prompt byte through the Worker-compatible string container", () => {
		for (const [file, prompt] of Object.entries(prompts)) {
			const raw = readFileSync(new URL(`./source/flyingcar/templates/${file}`, import.meta.url));
			expect(Buffer.from(prompt, "utf8")).toEqual(raw);
			expect(createHash("sha256").update(Buffer.from(prompt, "utf8")).digest("hex")).toBe(
				createHash("sha256").update(raw).digest("hex"),
			);
		}
	});
	it.each(keys)(
		"preserves %s prompt, selected resolution, references and original native audio",
		async (templateKey) => {
			const templateId = flyingCarTemplateIds[templateKey];
			const template = getVideoTemplate(templateId);
			for (const resolution of ["768P", "2K"] as const) {
				const request = resolveSourceTemplateRequest({
					templateKey,
					options: { resolution },
					userImageUrls: [userImageUrl],
					configs: { app_url: "https://media.example.com" },
					callbackUrl,
				});
				expect(request.executionContract).toBe("prompt");
				expect(request.provider).toBe("kie");
				expect(request.modelId).toBe("minimax-h3/reference-to-video");
				expect(request.prompt).toBe(getVideoPrompt(templateId));
				expect(request.revision).toBe(getVideoPromptVersion(templateId));
				expect(request.output).toEqual({
					durationSeconds: template.duration,
					aspectRatio: "16:9",
					resolution,
					sound: true,
				});
				const references = Array.from(
					{ length: template.referenceImageCount },
					(_, index) =>
						`https://media.example.com/flyingcar/templates/v1/${template.referenceAssetId}/reference-${String(index + 1).padStart(2, "0")}.jpg`,
				);
				const audio = `https://media.example.com/flyingcar/templates/v1/${template.referenceAssetId}/audio.wav`;
				expect(request.requiredAssetUrls).toEqual([...references, audio]);
				expect(request.body).toEqual({
					model: "minimax-h3/reference-to-video",
					callBackUrl: callbackUrl,
					input: {
						prompt: getVideoPrompt(templateId),
						reference_image_urls: [userImageUrl, ...references],
						reference_audio_urls: [audio],
						duration: template.duration,
						aspect_ratio: "16:9",
						resolution,
					},
				});
				expect(validateSourceKieH3Request(request.body)).toEqual(request.body);
				const fetcher = vi
					.fn<typeof fetch>()
					.mockResolvedValue(Response.json({ code: 200, data: { taskId: "flyingcar_1" } }));
				expect(await submitSourceTemplateRequest(request, { ...options, fetch: fetcher })).toEqual({
					status: "ACCEPTED",
					providerTaskId: "flyingcar_1",
				});
				expect(fetcher).toHaveBeenCalledTimes(1);
				expect(fetcher.mock.calls[0]![0]).toBe("https://api.kie.ai/api/v1/jobs/createTask");
				expect(JSON.parse(fetcher.mock.calls[0]![1]?.body as string)).toEqual(request.body);
			}
		},
	);
	it.each(keys)("prepares %s from only original archived private bytes", async (templateKey) => {
		const request = resolveSourceTemplateRequest({
			templateKey,
			userImageUrls: [userImageUrl],
			configs: prepareArchivedSourceTemplateConfig(templateKey),
		});
		for (const url of request.requiredAssetUrls) {
			const material = archivedSourceMaterials.find((asset) => asset.transportUrl === url);
			expect(material).toBeDefined();
			const bytes = readFileSync(new URL(material!.targetPath, import.meta.url));
			expect(createHash("sha256").update(bytes).digest("hex")).toBe(material!.sha256);
		}
		const fetcher = vi.fn<typeof fetch>();
		await expect(
			submitSourceTemplateRequest(request, { ...options, fetch: fetcher }),
		).rejects.toThrow("SOURCE_TEMPLATE_MATERIAL_UNBOUND");
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("keeps selected source asset-root configuration authoritative", () => {
		const request = resolveSourceTemplateRequest({
			templateKey: "flying-car-fleet-side",
			userImageUrls: [userImageUrl],
			configs: {
				app_url: "https://original.example.com",
				flyingcar_h3_asset_base_url: "https://assets.example.com/frozen/v2",
			},
		});
		expect(request.requiredAssetUrls[0]).toBe(
			"https://assets.example.com/frozen/v2/fleet-side/reference-01.jpg",
		);
		expect(request.prompt).toBe(getVideoPrompt("fleet-side"));
	});
	it("keeps V5 showcase and V6 curved ramp distinct while preserving the same original material", () => {
		const make = (templateKey: "flying-car-curved-ramp-showcase" | "flying-car-curved-ramp") =>
			resolveSourceTemplateRequest({
				templateKey,
				userImageUrls: [userImageUrl],
				configs: prepareArchivedSourceTemplateConfig(templateKey),
			});
		const showcase = make("flying-car-curved-ramp-showcase"),
			curved = make("flying-car-curved-ramp");
		expect(showcase.prompt).not.toBe(curved.prompt);
		expect(showcase.revision).toBe("flyingcar-h3-curved-ramp-v5");
		expect(curved.revision).toBe("flyingcar-h3-curved-ramp-v6");
		expect(showcase.requiredAssetUrls).toEqual(curved.requiredAssetUrls);
	});
	it("does not accept rewritten prompts, wrong photo count or changed fixed generation settings", () => {
		for (const choice of [
			{ durationSeconds: 10 },
			{ aspectRatio: "9:16" },
			{ resolution: "720p" },
			{ tier: "pro" },
			{ direction: "different scene" },
			{ preset: "solo" },
		])
			expect(() =>
				resolveSourceTemplateRequest({
					templateKey: "flying-car-fleet-side",
					options: choice as never,
					userImageUrls: [userImageUrl],
					configs: {},
				}),
			).toThrow();
		for (const images of [[], [userImageUrl, "https://private.example.com/extra.png"]])
			expect(() =>
				resolveSourceTemplateRequest({
					templateKey: "flying-car-fleet-side",
					userImageUrls: images,
					configs: {},
				}),
			).toThrow();
	});
	it("retrieves the exact same Kie model and leaves uncertain submission unreplayed", async () => {
		const request = resolveSourceTemplateRequest({
			templateKey: "flying-car-fleet-front",
			userImageUrls: [userImageUrl],
			configs: {},
		});
		const failing = vi.fn<typeof fetch>().mockRejectedValue(new Error("lost response"));
		expect(
			await submitSourceTemplateRequest(request, { ...options, fetch: failing }),
		).toMatchObject({ status: "UNCERTAIN" });
		expect(failing).toHaveBeenCalledTimes(1);
		const query = vi.fn<typeof fetch>().mockResolvedValue(
			Response.json({
				code: 200,
				data: {
					taskId: "flyingcar_1",
					model: request.modelId,
					state: "success",
					resultJson: JSON.stringify({ resultUrls: ["https://provider.example.com/video.mp4"] }),
				},
			}),
		);
		expect(
			await retrieveSourceTemplateRequest(request, "flyingcar_1", { ...options, fetch: query }),
		).toMatchObject({ status: "SUCCEEDED" });
		expect(query.mock.calls[0]![0]).toBe(
			"https://api.kie.ai/api/v1/jobs/recordInfo?taskId=flyingcar_1",
		);
	});
});
