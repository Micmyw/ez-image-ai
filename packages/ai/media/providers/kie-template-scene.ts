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
		const url = new URL(value);
		return url.protocol === "https:" && !url.username && !url.password && !url.hash;
	});
const sceneInput = z
	.object({
		productKey: z.literal("nano-banana-2-lite-1k"),
		prompt: z.string().min(1).max(10000),
		referenceUrls: z.tuple([httpsUrl, httpsUrl]),
		aspectRatio: z.literal("9:16"),
		outputCount: z.literal(1),
		callbackUrl: httpsUrl,
	})
	.strict();
export type KieTemplateSceneInput = z.infer<typeof sceneInput>;

/** Internal, ordered identity references. Never interpreted as first/last video frames. */
export function buildKieTemplateSceneRequest(value: KieTemplateSceneInput) {
	const input = sceneInput.parse(value);
	return {
		model: "nano-banana-2-lite",
		callBackUrl: input.callbackUrl,
		input: { prompt: input.prompt, image_urls: input.referenceUrls, aspect_ratio: "9:16" },
	};
}

/** Exactly one paid HTTP POST; durable fencing is owned by the template execution sidecar. */
export class KieTemplateSceneAdapter {
	constructor(private readonly options: HttpClientOptions & { apiKey: string }) {}
	async submit(value: KieTemplateSceneInput): Promise<KieVideoV1Submission> {
		const body = buildKieTemplateSceneRequest(value);
		if (!this.options.apiKey.trim())
			return {
				status: "DEFINITELY_REJECTED",
				reasonCode: "TEMPLATE_SCENE_PROVIDER_NOT_CONFIGURED",
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
					reasonCode: `TEMPLATE_SCENE_PROVIDER_REJECTED_${code}`,
				};
		} catch {
			/* The request may already have been accepted. */
		}
		return { status: "UNCERTAIN", reasonCode: "TEMPLATE_SCENE_SUBMISSION_UNCERTAIN" };
	}
	/** Unified Kie recordInfo validates exact task and one URL; no callback result is trusted. */
	retrieve(taskId: string): Promise<KieVideoV1Result> {
		return new KieVideoV1Adapter(this.options).retrieve(taskId);
	}
}
