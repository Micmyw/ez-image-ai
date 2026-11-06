import { z } from "zod";

import { HOTEL_LOBBY_ID, hotelLobbyRequestSchema, type HotelLobbyInput } from "./hotel-lobby";
import { RAP_MODEL_IDS, type RapModelId } from "./rap-catalog";
import { rapImageUrls, type RapGenerationInput } from "./rap-generation";
import { buildRapPrompt } from "./rap-prompt.server";

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const mediaUrl = z
	.url()
	.max(8192)
	.refine((value) => {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			!url.username &&
			!url.password &&
			/\.[a-z]{2,63}$/i.test(url.hostname) &&
			!/\.(localhost|local|internal)$/i.test(url.hostname)
		);
	});
const generationSchema = z.object({
	id: idSchema,
	model: z.enum(RAP_MODEL_IDS),
	endpoint: z.enum(["text-to-video", "image-to-video", "reference-to-video"]),
	provider: z.literal("seeapi"),
	status: z.enum(["processing", "succeeded", "failed", "canceled", "refunded", "expired"]),
	result: z
		.object({
			assets: z
				.array(
					z.object({
						type: z.enum(["image", "video", "audio"]),
						url: mediaUrl,
					}),
				)
				.max(16)
				.default([]),
		})
		.nullish(),
});
export type SeedanceGeneration = z.infer<typeof generationSchema>;
const hotelGenerationSchema = generationSchema.omit({ model: true, endpoint: true }).extend({
	template_id: z.literal(HOTEL_LOBBY_ID),
});
export function hotelLobbyBody(input: HotelLobbyInput, callbackUrl?: string) {
	const value = hotelLobbyRequestSchema.parse(input);
	return {
		provider: "seeapi" as const,
		...(callbackUrl ? { callback_url: callbackUrl } : {}),
		input: {
			reference_images: [value.imageUrl, value.secondImageUrl],
			aspect_ratio: value.aspectRatio,
			resolution: value.resolution,
		},
	};
}
export type HotelLobbyBody = ReturnType<typeof hotelLobbyBody>;
const stylePrompts = {
	studio: "Visual style: a minimal recording studio with controlled stage lighting.",
	street: "Visual style: an urban street performance with natural textures and street lighting.",
	cinematic:
		"Visual style: cinematic lighting, deliberate camera movement and a filmic composition.",
};
export type PrivateEffectInput = {
	prompt: string;
	referenceImages: string[];
	referenceAudio: string[];
};

export function seedanceBody(
	input: RapGenerationInput,
	callbackUrl?: string,
	effect?: PrivateEffectInput,
) {
	if (input.effect && !effect) throw new Error("EFFECT_TEMPLATE_REQUIRED");
	const images = input.mode === "image" ? rapImageUrls(input) : [];
	const duo = images.length === 2;
	const composed = Boolean(effect) || input.promptVersion === 1 || Boolean(input.composition);
	const direction = effect
		? effect.prompt
		: input.composition
			? buildRapPrompt({
					composition: input.composition,
					direction: input.direction,
					duration: input.duration as 5 | 8 | 10 | 12 | 15,
					aspectRatio: input.aspectRatio,
					photoCount: images.length,
				})
			: input.direction;
	const reference = duo || (composed && images.length > 0);
	return {
		model: input.modelId,
		endpoint: reference
			? ("reference-to-video" as const)
			: input.mode === "image"
				? ("image-to-video" as const)
				: ("text-to-video" as const),
		provider: "seeapi" as const,
		...(callbackUrl ? { callback_url: callbackUrl } : {}),
		input: {
			// Composed prompts already resolve scene, subjects and song content.
			// Keep the legacy adapter for old callers and persisted request replays.
			prompt: composed
				? direction
				: `${input.direction}\n\n${stylePrompts[input.performanceStyle]}${duo ? "\n\nUse both reference images as identity references. Bring the people from both photos together in the same rap performance, preserving their distinct appearances." : ""}`,
			...(reference
				? { reference_images: [...images, ...(effect?.referenceImages || [])] }
				: input.mode === "image"
					? { first_frame_image: input.imageUrl }
					: {}),
			...(effect?.referenceAudio.length ? { reference_audio: [...effect.referenceAudio] } : {}),
			aspect_ratio: input.aspectRatio,
			duration_seconds: input.duration,
			resolution: input.resolution,
			generate_audio: true,
			nsfw_checker: true,
		},
	};
}
export type SeedanceBody = ReturnType<typeof seedanceBody>;

export class SeeapiVideoError extends Error {
	constructor(
		public readonly code: string,
		public readonly definiteRejection = false,
	) {
		super(code);
	}
}

/** Official /v1/generations contract. Never expose the credential to the browser. */
export class SeeapiVideoClient {
	constructor(
		private readonly options: {
			apiKey: string;
			fetch?: typeof fetch;
			timeoutMs?: number;
			signal?: AbortSignal;
		},
	) {}

	async submit(body: SeedanceBody | HotelLobbyBody, idempotencyKey: string) {
		if (!idSchema.safeParse(idempotencyKey).success)
			throw new SeeapiVideoError("RAP_INPUT_INVALID");
		if (body.callback_url) {
			const callback = z.url().max(2048).safeParse(body.callback_url);
			if (!callback.success) throw new SeeapiVideoError("RAP_INPUT_INVALID");
			const url = new URL(callback.data);
			if (url.protocol !== "https:" || url.username || url.password || url.hash)
				throw new SeeapiVideoError("RAP_INPUT_INVALID");
		}
		return this.request(
			"model" in body ? "/v1/generations" : "/v1/templates/hotel-lobby-ai/generations",
			{
				method: "POST",
				headers: { "Idempotency-Key": idempotencyKey },
				body: JSON.stringify(body),
			},
			"model" in body ? body.endpoint : undefined,
			"model" in body ? body.model : HOTEL_LOBBY_ID,
		);
	}

	async query(
		id: string,
		endpoint: SeedanceBody["endpoint"] | undefined,
		model: RapModelId | typeof HOTEL_LOBBY_ID,
	) {
		if (!idSchema.safeParse(id).success)
			throw new SeeapiVideoError("RAP_PROVIDER_RESPONSE_INVALID");
		const task = await this.request(
			`/v1/generations/${encodeURIComponent(id)}`,
			{ method: "GET" },
			endpoint,
			model,
		);
		if (task.id !== id) throw new SeeapiVideoError("RAP_PROVIDER_RESPONSE_INVALID");
		return task;
	}

	private async request(
		path: string,
		init: RequestInit,
		endpoint: SeedanceBody["endpoint"] | undefined,
		model: RapModelId | typeof HOTEL_LOBBY_ID,
	): Promise<SeedanceGeneration | z.infer<typeof hotelGenerationSchema>> {
		if (!this.options.apiKey.trim()) throw new SeeapiVideoError("RAP_UNAVAILABLE");
		const controller = new AbortController();
		const signal = this.options.signal
			? AbortSignal.any([controller.signal, this.options.signal])
			: controller.signal;
		const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 20_000);
		try {
			const headers = new Headers(init.headers);
			headers.set("Authorization", `Bearer ${this.options.apiKey}`);
			headers.set("Content-Type", "application/json");
			const response = await (this.options.fetch ?? fetch)(`https://api.seeapi.com${path}`, {
				...init,
				headers,
				redirect: "manual",
				signal,
			});
			if (!response.ok) {
				void response.body?.cancel().catch(() => undefined);
				// 409 includes "still being created". 5xx/timeout/429 do not prove rejection.
				throw new SeeapiVideoError(
					"RAP_PROVIDER_UNAVAILABLE",
					init.method === "POST" && [400, 401, 402, 403, 404, 413, 422].includes(response.status),
				);
			}
			if (!response.body || Number(response.headers.get("content-length")) > 131072)
				throw new SeeapiVideoError("RAP_PROVIDER_RESPONSE_INVALID");
			const reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let size = 0;
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					size += value.byteLength;
					if (size > 131072) {
						await reader.cancel();
						throw new SeeapiVideoError("RAP_PROVIDER_RESPONSE_INVALID");
					}
					chunks.push(value);
				}
			} finally {
				reader.releaseLock();
			}
			const bytes = new Uint8Array(size);
			let offset = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, offset);
				offset += chunk.length;
			}
			const { generation } = z
				.object({
					generation: model === HOTEL_LOBBY_ID ? hotelGenerationSchema : generationSchema,
				})
				.parse(JSON.parse(new TextDecoder().decode(bytes)));
			if (
				(model === HOTEL_LOBBY_ID
					? !("template_id" in generation) || generation.template_id !== HOTEL_LOBBY_ID
					: !("model" in generation) ||
						generation.endpoint !== endpoint ||
						generation.model !== model) ||
				(generation.status === "succeeded" &&
					!generation.result?.assets.some((asset) => asset.type === "video"))
			)
				throw new SeeapiVideoError("RAP_PROVIDER_RESPONSE_INVALID");
			return generation;
		} catch (error) {
			if (error instanceof SeeapiVideoError) throw error;
			throw new SeeapiVideoError(
				controller.signal.aborted ? "RAP_PROVIDER_TIMEOUT" : "RAP_PROVIDER_UNAVAILABLE",
			);
		} finally {
			clearTimeout(timeout);
		}
	}
}
