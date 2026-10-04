import { videoModelInputSchema } from "@repo/config/video-models";
import { z } from "zod";

import { fetchJson, type HttpClientOptions } from "./http";
import type { KieVideoModelInput } from "./kie-video-models";
import type { KieVideoV1Result, KieVideoV1Submission } from "./kie-video-v1";

const httpsUrl = z
	.string()
	.max(4096)
	.refine(
		(value) =>
			value === value.trim() &&
			!Array.from(value).some((character) => {
				const code = character.charCodeAt(0);
				return code <= 0x20 || code === 0x7f;
			}),
	)
	.pipe(z.string().url())
	.refine((value) => {
		const url = new URL(value);
		return url.protocol === "https:" && !url.username && !url.password && !url.hash;
	});
const taskIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const resultSchema = z.object({
	taskId: taskIdSchema.nullish(),
	resultUrls: z.array(httpsUrl).length(1),
});

/** The documented legacy Veo endpoint takes top-level fields, not a Market input wrapper. */
export function buildKieVeoFastRequest(value: KieVideoModelInput) {
	const { callbackUrl, imageUrl, ...publicInput } = value;
	if (publicInput.productKey !== "video-veo-3-1-fast")
		throw new Error("VIDEO_MODEL_CONTRACT_UNAVAILABLE");
	const input = videoModelInputSchema.parse(publicInput);
	httpsUrl.parse(callbackUrl);
	const image = input.mode === "image-to-video";
	if (image) httpsUrl.parse(imageUrl);
	else if (imageUrl !== undefined) throw new Error("VIDEO_INPUT_ASSET_MODE_MISMATCH");
	return {
		model: "veo3_fast",
		prompt: input.prompt,
		callBackUrl: callbackUrl,
		duration: input.duration,
		resolution: input.resolution,
		aspect_ratio: input.aspectRatio === "source" ? "Auto" : input.aspectRatio,
		generationType: image ? "FIRST_AND_LAST_FRAMES_2_VIDEO" : "TEXT_2_VIDEO",
		enableTranslation: false,
		...(image ? { imageUrls: [imageUrl!] } : {}),
	};
}

/** A timezone-free provider date and an unspecified numeric time unit are not UTC evidence. */
function completionTime(value: unknown): string | null {
	const parsed = z.iso.datetime({ offset: true }).safeParse(value);
	if (!parsed.success) return null;
	const timestamp = Date.parse(parsed.data);
	return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function carriesTaskIdentity(value: unknown): boolean {
	if (value == null || typeof value !== "object") return false;
	return (
		("taskId" in value && value.taskId != null) || ("task_id" in value && value.task_id != null)
	);
}

function taskIdentityMatches(value: unknown, expected: string): boolean {
	if (value == null || typeof value !== "object") return true;
	return (
		(!("taskId" in value) || value.taskId === expected) &&
		(!("task_id" in value) || value.task_id === expected)
	);
}

/** One paid POST per invocation; ambiguous acceptance is never retried or failed over here. */
export class KieVeoFastAdapter {
	constructor(private readonly options: HttpClientOptions & { apiKey: string }) {}

	async submit(value: KieVideoModelInput): Promise<KieVideoV1Submission> {
		const body = buildKieVeoFastRequest(value);
		if (!this.options.apiKey.trim())
			return { status: "DEFINITELY_REJECTED", reasonCode: "VIDEO_PROVIDER_CONFIGURATION_ERROR" };
		try {
			const response = await fetchJson(
				"https://api.kie.ai/api/v1/veo/generate",
				{ method: "POST", redirect: "manual", headers: this.headers(), body: JSON.stringify(body) },
				{ ...this.options, maxResponseBytes: 64 * 1024 },
			);
			const envelope = z
				.object({ code: z.number().int(), data: z.unknown().nullish() })
				.safeParse(response.data);
			const accepted = z
				.object({ taskId: taskIdSchema })
				.safeParse(envelope.success ? envelope.data.data : undefined);
			const responseData =
				response.data != null && typeof response.data === "object" && "data" in response.data
					? response.data.data
					: undefined;
			const hasTaskIdentity =
				carriesTaskIdentity(response.data) || carriesTaskIdentity(responseData);
			if (
				response.ok &&
				envelope.success &&
				envelope.data.code === 200 &&
				accepted.success &&
				taskIdentityMatches(response.data, accepted.data.taskId) &&
				taskIdentityMatches(responseData, accepted.data.taskId)
			)
				return { status: "ACCEPTED", providerTaskId: accepted.data.taskId };
			// A task identity accompanying a rejection is contradictory: reserve and reconcile.
			// Code 400 explicitly includes "1080P is processing" in this legacy contract.
			if (
				envelope.success &&
				!hasTaskIdentity &&
				[401, 402, 404, 422].includes(envelope.data.code) &&
				(response.ok || response.status === envelope.data.code)
			)
				return {
					status: "DEFINITELY_REJECTED",
					reasonCode: `VIDEO_PROVIDER_REJECTED_${envelope.data.code}`,
				};
			return { status: "UNCERTAIN", reasonCode: "VIDEO_PROVIDER_SUBMISSION_UNCERTAIN" };
		} catch {
			return { status: "UNCERTAIN", reasonCode: "VIDEO_PROVIDER_SUBMISSION_UNCERTAIN" };
		}
	}

	/** Signed callbacks identify a task; this documented endpoint owns its authoritative result. */
	async retrieve(providerTaskId: string): Promise<KieVideoV1Result> {
		taskIdSchema.parse(providerTaskId);
		if (!this.options.apiKey.trim()) throw new Error("VIDEO_PROVIDER_CONFIGURATION_ERROR");
		const response = await fetchJson(
			`https://api.kie.ai/api/v1/veo/record-info?taskId=${encodeURIComponent(providerTaskId)}`,
			{ method: "GET", redirect: "manual", headers: this.headers() },
			{ ...this.options, maxResponseBytes: 64 * 1024 },
		);
		const record = z
			.object({
				code: z.literal(200),
				data: z.object({
					taskId: taskIdSchema,
					// The official prose defines 3, although its OpenAPI enum omits it.
					successFlag: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
					response: z.unknown().nullish(),
					paramJson: z
						.string()
						.max(32 * 1024)
						.nullish(),
					fallbackFlag: z.boolean().nullish(),
					completeTime: z.unknown().optional(),
					creditsConsumed: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).nullish(),
				}),
			})
			.safeParse(response.data);
		if (!response.ok || !record.success || record.data.data.taskId !== providerTaskId)
			throw new Error("VIDEO_PROVIDER_INVALID_RESPONSE");
		const data = record.data.data;
		if (data.paramJson != null) {
			try {
				const parameters = z.record(z.string(), z.unknown()).parse(JSON.parse(data.paramJson));
				if ("model" in parameters && parameters.model !== "veo3_fast")
					throw new Error("VIDEO_PROVIDER_INVALID_RESPONSE");
			} catch {
				throw new Error("VIDEO_PROVIDER_INVALID_RESPONSE");
			}
		}
		if (data.successFlag === 2 || data.successFlag === 3)
			return {
				status: "FAILED",
				reasonCode: "VIDEO_PROVIDER_GENERATION_FAILED",
				providerCostMicros: null,
				providerCreditsConsumed: data.creditsConsumed ?? null,
			};
		if (data.successFlag === 0) return { status: "PENDING" };
		const result = resultSchema.safeParse(data.response);
		if (
			!result.success ||
			(result.data.taskId != null && result.data.taskId !== providerTaskId) ||
			data.fallbackFlag === true
		)
			throw new Error("VIDEO_PROVIDER_INVALID_RESPONSE");
		return {
			status: "SUCCEEDED",
			outputUrl: result.data.resultUrls[0]!,
			providerCostMicros: null,
			providerCreditsConsumed: data.creditsConsumed ?? null,
			providerCompletedAt: completionTime(data.completeTime),
		};
	}

	private headers() {
		return { Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json" };
	}
}
