import { videoV1PromptSchema } from "@repo/config/video-v1";
import { z } from "zod";

import { fetchJson, type HttpClientOptions } from "./http";

const httpsUrl = z
	.string()
	.url()
	.max(4096)
	.refine((value) => {
		const url = new URL(value);
		return url.protocol === "https:" && !url.username && !url.password && !url.hash;
	});
const common = {
	prompt: videoV1PromptSchema,
	duration: z.literal(5),
	sound: z.literal(false),
	callbackUrl: httpsUrl,
};
const inputSchema = z.discriminatedUnion("mode", [
	z
		.object({
			...common,
			mode: z.literal("text-to-video"),
			aspectRatio: z.enum(["16:9", "9:16"]).default("16:9"),
		})
		.strict(),
	z.object({ ...common, mode: z.literal("image-to-video"), imageUrl: httpsUrl }).strict(),
]);
export type KieVideoV1Input = z.input<typeof inputSchema>;
export type KieVideoV1Submission =
	| { status: "ACCEPTED"; providerTaskId: string }
	| { status: "UNCERTAIN" | "DEFINITELY_REJECTED"; reasonCode: string };
export type KieVideoV1Result =
	| { status: "PENDING" }
	| {
			status: "SUCCEEDED";
			outputUrl: string;
			providerCostMicros: null;
			providerCreditsConsumed: number | null;
			providerCompletedAt: string | null;
	  }
	| {
			status: "FAILED";
			reasonCode: string;
			providerCostMicros: null;
			providerCreditsConsumed: number | null;
	  };
const taskIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
export function buildKieVideoV1Request(value: unknown) {
	const input = inputSchema.parse(value);
	return {
		model: `kling-2.6/${input.mode}`,
		callBackUrl: input.callbackUrl,
		input: {
			prompt: input.prompt,
			duration: "5",
			sound: false,
			...(input.mode === "text-to-video"
				? { aspect_ratio: input.aspectRatio }
				: { image_urls: [input.imageUrl] }),
		},
	};
}

/** Dedicated Kling contract. No generic registry fallback and no paid-request retry. */
export class KieVideoV1Adapter {
	constructor(private readonly options: HttpClientOptions & { apiKey: string }) {}
	async submit(value: KieVideoV1Input): Promise<KieVideoV1Submission> {
		const body = buildKieVideoV1Request(value);
		if (!this.options.apiKey.trim())
			return { status: "DEFINITELY_REJECTED", reasonCode: "VIDEO_PROVIDER_CONFIGURATION_ERROR" };
		try {
			const response = await fetchJson(
				"https://api.kie.ai/api/v1/jobs/createTask",
				{ method: "POST", redirect: "manual", headers: this.headers(), body: JSON.stringify(body) },
				{ ...this.options, maxResponseBytes: 64 * 1024 },
			);
			const envelope = z
				.object({ code: z.number(), data: z.unknown().nullish() })
				.safeParse(response.data);
			if (response.ok && envelope.success && envelope.data.code === 200) {
				const accepted = z.object({ taskId: taskIdSchema }).safeParse(envelope.data.data);
				if (accepted.success) return { status: "ACCEPTED", providerTaskId: accepted.data.taskId };
			}
			// Only documented explicit client rejection codes can prove non-acceptance.
			const code = response.ok && envelope.success ? envelope.data.code : response.status;
			if ([400, 401, 402, 403, 404, 422].includes(code))
				return { status: "DEFINITELY_REJECTED", reasonCode: `VIDEO_PROVIDER_REJECTED_${code}` };
			return { status: "UNCERTAIN", reasonCode: "VIDEO_PROVIDER_SUBMISSION_UNCERTAIN" };
		} catch {
			return { status: "UNCERTAIN", reasonCode: "VIDEO_PROVIDER_SUBMISSION_UNCERTAIN" };
		}
	}
	async retrieve(providerTaskId: string): Promise<KieVideoV1Result> {
		return this.retrieveResult(providerTaskId);
	}
	/** Separate from retrieve so injected legacy adapter implementations stay compatible. */
	async retrieveVeo(
		providerTaskId: string,
		veo: { resolution: string; model: string },
	): Promise<KieVideoV1Result> {
		if (
			!z
				.object({
					resolution: z.enum(["720p", "1080p", "4k"]),
					model: z.enum(["veo3_lite", "veo3_fast", "veo3"]),
				})
				.safeParse(veo).success
		)
			throw new Error("VIDEO_MODEL_CONTRACT_UNAVAILABLE");
		return this.retrieveResult(providerTaskId, veo);
	}
	private async retrieveResult(
		providerTaskId: string,
		veo?: { resolution: string; model: string },
	): Promise<KieVideoV1Result> {
		taskIdSchema.parse(providerTaskId);
		if (!this.options.apiKey.trim()) throw new Error("VIDEO_PROVIDER_CONFIGURATION_ERROR");
		const response = await fetchJson(
			`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`,
			{ method: "GET", redirect: "manual", headers: this.headers() },
			{ ...this.options, maxResponseBytes: 64 * 1024 },
		);
		const record = z
			.object({
				code: z.literal(200),
				data: z.object({
					taskId: taskIdSchema,
					model: z.unknown().optional(),
					param: z.unknown().optional(),
					state: z.enum(["waiting", "queuing", "generating", "success", "fail"]),
					resultJson: z
						.string()
						.max(32 * 1024)
						.nullish(),
					completeTime: z.number().int().positive().nullish(),
					creditsConsumed: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).nullish(),
				}),
			})
			.safeParse(response.data);
		if (!response.ok || !record.success || record.data.data.taskId !== providerTaskId)
			throw new Error("VIDEO_PROVIDER_INVALID_RESPONSE");
		const data = record.data.data;
		if (veo) {
			try {
				if (data.model != null && data.model !== "veo-3-1") throw new Error();
				if (data.param != null) {
					const params = z.object({ model: z.literal("veo-3-1"), input: z.unknown() }).parse(
						JSON.parse(
							z
								.string()
								.max(32 * 1024)
								.parse(data.param),
						),
					);
					z.object({ model: z.literal(veo.model), resolution: z.literal(veo.resolution) }).parse(
						typeof params.input === "string" ? JSON.parse(params.input) : params.input,
					);
				}
			} catch {
				throw new Error("VIDEO_PROVIDER_INVALID_RESPONSE");
			}
		}
		if (data.state === "fail")
			return {
				status: "FAILED",
				reasonCode: "VIDEO_PROVIDER_GENERATION_FAILED",
				providerCostMicros: null,
				providerCreditsConsumed: data.creditsConsumed ?? null,
			};
		if (data.state !== "success") return { status: "PENDING" };
		try {
			const decoded = JSON.parse(data.resultJson ?? "null");
			// Only frozen explicit-tier high resolution jobs select this response shape.
			// origin_urls is the 720p source, never a fallback for a high resolution order.
			const urls =
				veo && veo.resolution !== "720p"
					? z
							.object({ data: z.object({ result_urls: z.array(httpsUrl).length(1) }) })
							.parse(decoded).data.result_urls
					: z.object({ resultUrls: z.array(httpsUrl).length(1) }).parse(decoded).resultUrls;
			return {
				status: "SUCCEEDED",
				outputUrl: urls[0]!,
				providerCostMicros: null,
				providerCreditsConsumed: data.creditsConsumed ?? null,
				providerCompletedAt: data.completeTime ? new Date(data.completeTime).toISOString() : null,
			};
		} catch {
			throw new Error("VIDEO_PROVIDER_INVALID_RESPONSE");
		}
	}
	private headers() {
		return { Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json" };
	}
}

/** Kie signs the task identity only; callers MUST query recordInfo before trusting any body state or URL. */
export async function verifyKieVideoWebhook(input: {
	taskId: string;
	timestamp: string | null;
	signature: string | null;
	secret: string;
	nowSeconds?: number;
}): Promise<boolean> {
	if (
		!taskIdSchema.safeParse(input.taskId).success ||
		!input.secret.trim() ||
		!input.timestamp ||
		!/^\d{10}$/.test(input.timestamp) ||
		!input.signature ||
		!/^[A-Za-z0-9+/]{43}=$/.test(input.signature)
	)
		return false;
	const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
	const delta = now - Number(input.timestamp);
	if (delta > 300 || delta < -30) return false;
	try {
		const key = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(input.secret),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["verify"],
		);
		const signature = Uint8Array.from(atob(input.signature), (value) => value.charCodeAt(0));
		return await crypto.subtle.verify(
			"HMAC",
			key,
			signature,
			new TextEncoder().encode(`${input.taskId}.${input.timestamp}`),
		);
	} catch {
		return false;
	}
}
