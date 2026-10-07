import { z } from "zod";

import { fetchJson, type HttpClientOptions } from "./http";
import {
	KieVideoV1Adapter,
	type KieVideoV1Result,
	type KieVideoV1Submission,
} from "./kie-video-v1";

const httpsUrl = z
	.string()
	.url()
	.max(4096)
	.refine((value) => {
		try {
			const url = new URL(value);
			return url.protocol === "https:" && !url.username && !url.password && !url.hash;
		} catch {
			return false;
		}
	});

/** Server-only reference mode. First/last frames and arbitrary provider options are rejected. */
export const kieSeedanceReferenceInputSchema = z
	.object({
		productKey: z.literal("video-seedance-2"),
		prompt: z.string().trim().min(1).max(10000),
		duration: z.literal(5),
		resolution: z.literal("720p"),
		aspectRatio: z.literal("9:16"),
		sound: z.literal(false),
		referenceImageUrls: z.array(httpsUrl).min(1).max(9),
		referenceVideoUrls: z.array(httpsUrl).min(1).max(3),
		callbackUrl: httpsUrl,
	})
	.strict();

export type KieSeedanceReferenceInput = z.infer<typeof kieSeedanceReferenceInputSchema>;

/** Internal references are not first frames and do not promise pixel-preserving replacement. */
export function buildKieSeedanceReferenceRequest(value: unknown) {
	const input = kieSeedanceReferenceInputSchema.parse(value);
	return {
		model: "bytedance/seedance-2",
		callBackUrl: input.callbackUrl,
		input: {
			prompt: input.prompt,
			duration: input.duration,
			resolution: input.resolution,
			aspect_ratio: input.aspectRatio,
			reference_image_urls: input.referenceImageUrls,
			reference_video_urls: input.referenceVideoUrls,
			generate_audio: false,
			nsfw_checker: true,
			web_search: false,
			return_last_frame: false,
		},
	};
}

/** Exactly one paid POST. The execution sidecar owns durable submission fencing and settlement. */
export class KieSeedanceReferenceAdapter {
	constructor(private readonly options: HttpClientOptions & { apiKey: string }) {}

	async submit(value: KieSeedanceReferenceInput): Promise<KieVideoV1Submission> {
		const body = buildKieSeedanceReferenceRequest(value);
		if (!this.options.apiKey.trim())
			return {
				status: "DEFINITELY_REJECTED",
				reasonCode: "VIDEO_PROVIDER_CONFIGURATION_ERROR",
			};
		try {
			const response = await fetchJson(
				"https://api.kie.ai/api/v1/jobs/createTask",
				{
					method: "POST",
					redirect: "manual",
					headers: {
						Authorization: `Bearer ${this.options.apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(body),
				},
				{ ...this.options, maxResponseBytes: 64 * 1024 },
			);
			const envelope = z
				.object({ code: z.number(), data: z.unknown().nullish() })
				.safeParse(response.data);
			if (response.ok && envelope.success && envelope.data.code === 200) {
				const result = z
					.object({ taskId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/) })
					.safeParse(envelope.data.data);
				if (result.success) return { status: "ACCEPTED", providerTaskId: result.data.taskId };
			}
			const code = response.ok && envelope.success ? envelope.data.code : response.status;
			if ([400, 401, 402, 403, 404, 422].includes(code))
				return {
					status: "DEFINITELY_REJECTED",
					reasonCode: `VIDEO_PROVIDER_REJECTED_${code}`,
				};
		} catch {
			/* Acceptance may already have happened; do not retry or release reserved credits. */
		}
		return { status: "UNCERTAIN", reasonCode: "VIDEO_PROVIDER_SUBMISSION_UNCERTAIN" };
	}

	/** recordInfo verifies the exact task and output URL; callback payloads are not authoritative. */
	retrieve(taskId: string): Promise<KieVideoV1Result> {
		return new KieVideoV1Adapter(this.options).retrieve(taskId);
	}
}
