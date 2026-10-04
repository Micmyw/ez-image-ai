import {
	getVideoModel,
	videoModelInputSchema,
	type VideoModelInput,
	type VideoMode,
} from "@repo/config/video-models";
import { z } from "zod";

import { fetchJson, type HttpClientOptions } from "./http";
import {
	KieVideoV1Adapter,
	type KieVideoV1Result,
	type KieVideoV1Submission,
} from "./kie-video-v1";

export type KieVideoModelInput = VideoModelInput & { callbackUrl: string; imageUrl?: string };
const httpsUrl = z
	.string()
	.url()
	.max(4096)
	.refine((value) => {
		const url = new URL(value);
		return url.protocol === "https:" && !url.username && !url.password && !url.hash;
	});
const taskIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);

export function resolveKieVideoModelId(productKey: string, mode: VideoMode): string {
	const entry = getVideoModel(productKey);
	if (entry?.status !== "implemented" || !entry.modes.includes(mode))
		throw new Error("VIDEO_MODEL_CONTRACT_UNAVAILABLE");
	switch (productKey) {
		case "video-kling-2-6-v1":
			return `kling-2.6/${mode}`;
		case "video-kling-3":
			return "kling-3.0/video";
		case "video-kling-3-turbo":
			return `kling/v3-turbo-${mode}`;
		case "video-minimax-h3":
			return `minimax-h3/${mode}`;
		case "video-seedance-1-pro-fast":
			return "bytedance/v1-pro-fast-image-to-video";
		case "video-seedance-1-5-pro":
			return "bytedance/seedance-1.5-pro";
		case "video-seedance-2":
		case "video-seedance-2-5":
		case "video-seedance-2-mini":
		case "video-seedance-2-fast":
			return `bytedance/${productKey.slice("video-".length)}`;
		case "video-gemini-omni-flash":
			return "google/gemini-omni-flash-1-1";
		case "video-veo-3-1":
			return "veo-3-1";
		default:
			throw new Error("VIDEO_MODEL_CONTRACT_UNAVAILABLE");
	}
}

/** Server-only mapping. A competitor label never selects a provider route. */
export function buildKieVideoModelRequest(value: KieVideoModelInput) {
	const { callbackUrl, imageUrl, ...publicInput } = value;
	const input = videoModelInputSchema.parse(publicInput);
	httpsUrl.parse(callbackUrl);
	if (input.mode === "image-to-video") httpsUrl.parse(imageUrl);
	else if (imageUrl !== undefined) throw new Error("VIDEO_INPUT_ASSET_MODE_MISMATCH");
	const model = resolveKieVideoModelId(input.productKey, input.mode);
	let parameters: Record<string, unknown> = { prompt: input.prompt };
	const image = input.mode === "image-to-video";
	switch (input.productKey) {
		case "video-kling-2-6-v1":
			parameters = {
				...parameters,
				duration: String(input.duration),
				sound: input.sound,
				...(image ? { image_urls: [imageUrl] } : { aspect_ratio: input.aspectRatio }),
			};
			break;
		case "video-kling-3":
			parameters = {
				...parameters,
				duration: String(input.duration),
				sound: input.sound,
				mode: { "720p": "std", "1080p": "pro", "4k": "4K" }[input.resolution],
				multi_shots: false,
				...(input.aspectRatio !== "source" ? { aspect_ratio: input.aspectRatio } : {}),
				...(image ? { image_urls: [imageUrl] } : {}),
			};
			break;
		case "video-kling-3-turbo":
			parameters = {
				...parameters,
				duration: String(input.duration),
				resolution: input.resolution,
				...(image ? { image_urls: [imageUrl] } : { aspect_ratio: input.aspectRatio }),
			};
			break;
		case "video-minimax-h3":
			parameters = {
				...parameters,
				duration: input.duration,
				resolution: input.resolution === "768p" ? "768P" : "2K",
				...(image ? { first_frame_url: imageUrl } : { aspect_ratio: input.aspectRatio }),
			};
			break;
		case "video-seedance-1-pro-fast":
			parameters = {
				...parameters,
				image_url: imageUrl,
				duration: String(input.duration),
				resolution: input.resolution,
				nsfw_checker: true,
			};
			break;
		case "video-seedance-1-5-pro":
			parameters = {
				...parameters,
				duration: input.duration,
				resolution: input.resolution,
				aspect_ratio: input.aspectRatio,
				generate_audio: input.sound,
				fixed_lens: false,
				nsfw_checker: true,
				...(image ? { input_urls: [imageUrl] } : {}),
			};
			break;
		case "video-seedance-2":
		case "video-seedance-2-5":
		case "video-seedance-2-mini":
		case "video-seedance-2-fast":
			parameters = {
				...parameters,
				duration: input.duration,
				resolution: input.resolution,
				aspect_ratio: input.aspectRatio,
				generate_audio: input.sound,
				nsfw_checker: true,
				web_search: false,
				...(input.productKey === "video-seedance-2-5" ? { output_format: "mp4" } : {}),
				...(image ? { first_frame_url: imageUrl } : {}),
			};
			break;
		case "video-gemini-omni-flash":
			parameters = {
				...parameters,
				duration: String(input.duration),
				resolution: input.resolution,
				aspect_ratio: input.aspectRatio,
				...(image ? { first_frame_url: imageUrl } : {}),
			};
			break;
		case "video-veo-3-1":
			parameters = {
				...parameters,
				duration: input.duration,
				resolution: input.resolution,
				aspect_ratio: input.aspectRatio === "source" ? "Auto" : input.aspectRatio,
				enable_translation: false,
				generation_type: image ? "FIRST_AND_LAST_FRAMES_2_VIDEO" : "TEXT_2_VIDEO",
				...(image ? { image_urls: [imageUrl] } : {}),
			};
			break;
		default:
			throw new Error("VIDEO_MODEL_CONTRACT_UNAVAILABLE");
	}
	return { model, callBackUrl: callbackUrl, input: parameters };
}

/** Exactly one createTask request. Uncertain acceptance always stays uncertain; never fail over. */
export class KieVideoModelsAdapter {
	constructor(private readonly options: HttpClientOptions & { apiKey: string }) {}
	async submit(value: KieVideoModelInput): Promise<KieVideoV1Submission> {
		const body = buildKieVideoModelRequest(value);
		if (!this.options.apiKey.trim())
			return { status: "DEFINITELY_REJECTED", reasonCode: "VIDEO_PROVIDER_CONFIGURATION_ERROR" };
		try {
			const response = await fetchJson(
				"https://api.kie.ai/api/v1/jobs/createTask",
				{
					method: "POST",
					redirect: "manual",
					headers: this.headers(),
					body: JSON.stringify(body),
				},
				{ ...this.options, maxResponseBytes: 64 * 1024 },
			);
			const envelope = z
				.object({ code: z.number(), data: z.unknown().nullish() })
				.safeParse(response.data);
			if (response.ok && envelope.success && envelope.data.code === 200) {
				const accepted = z.object({ taskId: taskIdSchema }).safeParse(envelope.data.data);
				if (accepted.success) return { status: "ACCEPTED", providerTaskId: accepted.data.taskId };
			}
			const code = response.ok && envelope.success ? envelope.data.code : response.status;
			if ([400, 401, 402, 403, 404, 422].includes(code))
				return { status: "DEFINITELY_REJECTED", reasonCode: `VIDEO_PROVIDER_REJECTED_${code}` };
			return { status: "UNCERTAIN", reasonCode: "VIDEO_PROVIDER_SUBMISSION_UNCERTAIN" };
		} catch {
			return { status: "UNCERTAIN", reasonCode: "VIDEO_PROVIDER_SUBMISSION_UNCERTAIN" };
		}
	}
	/** All listed models use the documented unified task record contract, not callback body results. */
	async retrieve(providerTaskId: string, productKey?: string): Promise<KieVideoV1Result> {
		if (productKey && getVideoModel(productKey)?.status !== "implemented")
			throw new Error("VIDEO_MODEL_CONTRACT_UNAVAILABLE");
		return new KieVideoV1Adapter(this.options).retrieve(providerTaskId);
	}
	private headers() {
		return { Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json" };
	}
}
