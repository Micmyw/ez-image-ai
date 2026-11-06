import { z } from "zod";

import type { KieVideoV1Result, KieVideoV1Submission } from "../providers/kie-video-v1";
import type { ResolvedSourceTemplateRequest } from "./contracts";
import { HOTEL_LOBBY_ID, HOTEL_LOBBY_RATIOS, HOTEL_LOBBY_RESOLUTIONS } from "./source/hotel-lobby";
import { KIE_H3_REFERENCE_MODEL, KIE_H3_RESOLUTIONS } from "./source/kie-constants";
import { RAP_MODEL_IDS } from "./source/rap-catalog";
import {
	SeeapiVideoClient,
	SeeapiVideoError,
	type HotelLobbyBody,
	type SeedanceBody,
} from "./source/seeapi-video";

export type SourceTemplateTransportOptions = {
	apiKey: string;
	fetch?: typeof fetch;
	timeoutMs?: number;
	signal?: AbortSignal;
};
export type SourceTemplateTransportRequest = Pick<
	ResolvedSourceTemplateRequest,
	"provider" | "modelId" | "endpoint" | "body"
>;
const taskIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const httpsUrl = z
	.url()
	.max(8192)
	.refine((value) => {
		const url = new URL(value);
		return url.protocol === "https:" && !url.username && !url.password && !url.hash;
	});

/** Same H3 reference modes as source src/core/ai/kie.ts; no model substitution. */
export function validateSourceKieH3Request(value: unknown) {
	const body = z
		.object({
			model: z.literal(KIE_H3_REFERENCE_MODEL),
			callBackUrl: httpsUrl.optional(),
			input: z
				.object({
					prompt: z.string().min(1).max(7000),
					reference_image_urls: z.array(httpsUrl).min(3).max(7),
					reference_audio_urls: z.array(httpsUrl).length(1),
					duration: z.number().int(),
					aspect_ratio: z.enum(["9:16", "16:9"]),
					resolution: z.enum(KIE_H3_RESOLUTIONS),
				})
				.strict(),
		})
		.strict()
		.parse(value);
	const options = body.input;
	const count = options.reference_image_urls.length;
	const supportedContract =
		([3, 4, 5].includes(count) && options.duration === 15 && options.aspect_ratio === "9:16") ||
		(options.aspect_ratio === "9:16" &&
			options.resolution === "768P" &&
			((count === 3 && [6, 9].includes(options.duration)) ||
				([4, 5].includes(count) && options.duration === 12))) ||
		(options.aspect_ratio === "16:9" &&
			((count === 7 && options.duration === 15) ||
				(count === 6 && options.duration === 7) ||
				(count === 5 && options.duration === 10 && options.resolution === "768P")));
	if (!supportedContract || !options.prompt.trim())
		throw new Error("SOURCE_TEMPLATE_CONTRACT_INVALID");
	return body;
}

function assertEnvelope(request: SourceTemplateTransportRequest) {
	if (request.provider === "kie") {
		if (request.modelId !== KIE_H3_REFERENCE_MODEL || request.endpoint !== "reference-to-video")
			throw new Error("SOURCE_TEMPLATE_CONTRACT_INVALID");
		validateSourceKieH3Request(request.body);
	} else if (request.provider === "seeapi") {
		const body = request.body;
		if (!("provider" in body) || body.provider !== "seeapi")
			throw new Error("SOURCE_TEMPLATE_CONTRACT_INVALID");
		if (request.modelId === HOTEL_LOBBY_ID) {
			if (request.endpoint !== HOTEL_LOBBY_ID || "model" in body || "endpoint" in body)
				throw new Error("SOURCE_TEMPLATE_CONTRACT_INVALID");
			// A hosted template is a complete separate contract. Adding prompt/model/
			// duration would mutate its source generation method, not fill a gap.
			z.object({
				provider: z.literal("seeapi"),
				callback_url: httpsUrl.optional(),
				input: z
					.object({
						reference_images: z.array(httpsUrl).length(2),
						aspect_ratio: z.enum(HOTEL_LOBBY_RATIOS),
						resolution: z.enum(HOTEL_LOBBY_RESOLUTIONS),
					})
					.strict(),
			})
				.strict()
				.parse(body);
		} else {
			if (
				!RAP_MODEL_IDS.some((id) => id === request.modelId) ||
				!("model" in body) ||
				!("endpoint" in body) ||
				body.model !== request.modelId ||
				body.endpoint !== request.endpoint
			)
				throw new Error("SOURCE_TEMPLATE_CONTRACT_INVALID");
		}
	} else throw new Error("SOURCE_TEMPLATE_CONTRACT_INVALID");
}

/** One bounded request. The target runtime owns leases and all recovery decisions. */
async function kieRequest(
	path: string,
	init: RequestInit,
	options: SourceTemplateTransportOptions,
) {
	if (!options.apiKey.trim()) throw new Error("VIDEO_PROVIDER_CONFIGURATION_ERROR");
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
	const signal = options.signal
		? AbortSignal.any([options.signal, controller.signal])
		: controller.signal;
	try {
		const response = await (options.fetch ?? fetch)(`https://api.kie.ai/api/v1/jobs/${path}`, {
			...init,
			headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
			redirect: "manual",
			signal,
		});
		if (!response.body || Number(response.headers.get("content-length")) > 131072) {
			void response.body?.cancel().catch(() => undefined);
			throw new Error("VIDEO_PROVIDER_INVALID_RESPONSE");
		}
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let content = "";
		let bytes = 0;
		try {
			while (true) {
				const next = await reader.read();
				if (next.done) break;
				bytes += next.value.byteLength;
				if (bytes > 131072) {
					await reader.cancel();
					throw new Error("VIDEO_PROVIDER_INVALID_RESPONSE");
				}
				content += decoder.decode(next.value, { stream: true });
			}
			content += decoder.decode();
		} finally {
			reader.releaseLock();
		}
		return { ok: response.ok, status: response.status, body: JSON.parse(content) as unknown };
	} finally {
		clearTimeout(timeout);
	}
}

export async function submitSourceTemplateRequest(
	request: SourceTemplateTransportRequest,
	options: SourceTemplateTransportOptions & { idempotencyKey: string },
): Promise<KieVideoV1Submission> {
	assertEnvelope(request);
	// Offline material identities must never escape to a paid provider request.
	JSON.stringify(request.body, (_key, value: unknown) => {
		if (
			typeof value === "string" &&
			URL.canParse(value) &&
			new URL(value).hostname === "ezpic-template.example"
		)
			throw new Error("SOURCE_TEMPLATE_MATERIAL_UNBOUND");
		return value;
	});
	taskIdSchema.parse(options.idempotencyKey);
	if (!options.apiKey.trim())
		return { status: "DEFINITELY_REJECTED", reasonCode: "VIDEO_PROVIDER_CONFIGURATION_ERROR" };
	try {
		if (request.provider === "seeapi") {
			const result = await new SeeapiVideoClient(options).submit(
				request.body as SeedanceBody | HotelLobbyBody,
				options.idempotencyKey,
			);
			return { status: "ACCEPTED", providerTaskId: result.id };
		}
		const response = await kieRequest(
			"createTask",
			{ method: "POST", body: JSON.stringify(request.body) },
			options,
		);
		const envelope = z
			.object({
				code: z.number(),
				data: z.object({ taskId: z.string().max(512).nullish() }).nullish(),
			})
			.safeParse(response.body);
		if (response.ok && envelope.success && envelope.data.code === 200 && envelope.data.data?.taskId)
			return { status: "ACCEPTED", providerTaskId: envelope.data.data.taskId };
		// Keep target uncertainty protection for 409/429 even when source classified
		// them as rejection. A conflicting accepted task always wins over a code.
		if (
			envelope.success &&
			!envelope.data.data?.taskId &&
			[400, 401, 402, 403, 404, 405, 422, 433, 455].includes(envelope.data.code)
		)
			return {
				status: "DEFINITELY_REJECTED",
				reasonCode: `VIDEO_PROVIDER_REJECTED_${envelope.data.code}`,
			};
		return { status: "UNCERTAIN", reasonCode: "VIDEO_PROVIDER_SUBMISSION_UNCERTAIN" };
	} catch (error) {
		if (error instanceof SeeapiVideoError && error.definiteRejection)
			return { status: "DEFINITELY_REJECTED", reasonCode: error.code };
		return { status: "UNCERTAIN", reasonCode: "VIDEO_PROVIDER_SUBMISSION_UNCERTAIN" };
	}
}

export async function retrieveSourceTemplateRequest(
	request: SourceTemplateTransportRequest,
	providerTaskId: string,
	options: SourceTemplateTransportOptions,
): Promise<KieVideoV1Result> {
	assertEnvelope(request);
	if (request.provider === "seeapi") {
		const result = await new SeeapiVideoClient(options).query(
			providerTaskId,
			request.endpoint === HOTEL_LOBBY_ID ? undefined : request.endpoint,
			request.modelId as (typeof RAP_MODEL_IDS)[number] | typeof HOTEL_LOBBY_ID,
		);
		if (result.status === "processing") return { status: "PENDING" };
		if (result.status !== "succeeded")
			return {
				status: "FAILED",
				reasonCode: "VIDEO_PROVIDER_GENERATION_FAILED",
				providerCostMicros: null,
				providerCreditsConsumed: null,
			};
		const videos = result.result?.assets.filter((asset) => asset.type === "video") ?? [];
		if (videos.length !== 1) throw new Error("VIDEO_PROVIDER_INVALID_RESPONSE");
		return {
			status: "SUCCEEDED",
			outputUrl: videos[0]!.url,
			providerCostMicros: null,
			providerCreditsConsumed: null,
			providerCompletedAt: null,
		};
	}
	z.string().min(1).max(512).parse(providerTaskId);
	const response = await kieRequest(
		`recordInfo?taskId=${encodeURIComponent(providerTaskId)}`,
		{ method: "GET" },
		options,
	);
	const record = z
		.object({
			code: z.literal(200),
			data: z.object({
				taskId: z.string(),
				model: z.string().nullish(),
				state: z.enum([
					"waiting",
					"queuing",
					"generating",
					"success",
					"fail",
					"canceled",
					"cancelled",
				]),
				resultJson: z.string().max(65536).nullish(),
				completeTime: z.number().int().positive().nullish(),
				creditsConsumed: z.number().finite().nonnegative().nullish(),
			}),
		})
		.parse(response.body);
	const data = record.data;
	if (
		!response.ok ||
		data.taskId !== providerTaskId ||
		(data.model != null && data.model !== request.modelId)
	)
		throw new Error("VIDEO_PROVIDER_INVALID_RESPONSE");
	if (["fail", "canceled", "cancelled"].includes(data.state))
		return {
			status: "FAILED",
			reasonCode: "VIDEO_PROVIDER_GENERATION_FAILED",
			providerCostMicros: null,
			providerCreditsConsumed: data.creditsConsumed ?? null,
		};
	if (data.state !== "success") return { status: "PENDING" };
	const result = z
		.object({ resultUrls: z.array(httpsUrl).length(1) })
		.parse(JSON.parse(data.resultJson ?? "null"));
	return {
		status: "SUCCEEDED",
		outputUrl: result.resultUrls[0]!,
		providerCostMicros: null,
		providerCreditsConsumed: data.creditsConsumed ?? null,
		providerCompletedAt: data.completeTime ? new Date(data.completeTime).toISOString() : null,
	};
}
