import { z } from "zod";

import { fetchJson, type HttpClientOptions } from "../providers/http";
import type {
	ModerationDecision,
	ModerationSubmission,
	RetrieveModerationInput,
	SubmitVideoInput,
} from "./types";

const label = z.string().min(1).max(128);
const taskSchema = z.object({
	id: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
	object: z.literal("inference"),
	model: z.literal("nsfw-filter"),
	endpoint: z.literal("image-moderation"),
	provider: z.literal("seeapi"),
	status: z.enum(["queued", "processing", "succeeded", "failed", "canceled"]),
	result: z
		.object({
			type: z.literal("json"),
			data: z.object({
				flagged: z.boolean(),
				categories: z.object({
					nsfw: z.array(label).max(100),
					special_care: z.array(label).max(100),
				}),
			}),
		})
		.nullable(),
	error: z.unknown().refine((value) => value === null),
});

export class SeeapiSafetyAdapter {
	constructor(private readonly options: HttpClientOptions & { apiKey: string }) {}
	async submitImage(input: SubmitVideoInput): Promise<ModerationSubmission> {
		const task = await this.call("/v1/inferences", {
			method: "POST",
			headers: { "Idempotency-Key": input.idempotencyKey },
			body: JSON.stringify({
				model: "nsfw-filter",
				endpoint: "image-moderation",
				provider: "seeapi",
				input: { image_url: input.assetUrl, threshold_offset: 0, strict_special_care: true },
			}),
		});
		if (!["queued", "processing", "succeeded"].includes(task.status))
			throw new Error("MODERATION_UNAVAILABLE");
		return {
			moderationTaskId: task.id,
			status: task.status === "queued" ? "QUEUED" : "RUNNING",
			ruleVersion: input.ruleVersion,
			idempotency: { key: input.idempotencyKey, providerSupported: true, replayed: false },
		};
	}
	async retrieveImage(input: RetrieveModerationInput): Promise<ModerationDecision> {
		const result = (
			decision: ModerationDecision["decision"],
			reasonCode: string,
		): ModerationDecision => ({ decision, reasonCode, ruleVersion: input.ruleVersion });
		try {
			const task = await this.call(`/v1/inferences/${encodeURIComponent(input.moderationTaskId)}`, {
				method: "GET",
			});
			if (task.id !== input.moderationTaskId) return result("ERROR", "MODERATION_INVALID_RESPONSE");
			if (task.status === "queued" || task.status === "processing")
				return result("REVIEW", "IMAGE_PROCESSING");
			if (task.status !== "succeeded" || !task.result)
				return result("ERROR", "MODERATION_UNAVAILABLE");
			const data = task.result.data;
			const verdict = data.flagged
				? result("REJECT", "SEEAPI_CONTENT_NOT_ALLOWED")
				: data.categories.nsfw.length || data.categories.special_care.length
					? result("REVIEW", "SEEAPI_CONTENT_REVIEW")
					: result("ALLOW", "NO_POLICY_MATCH");
			return {
				...verdict,
				evidence: {
					requestId: task.id,
					models: ["nsfw-filter"],
					operations: 1,
					scores: {},
					seeapi: {
						taskId: task.id,
						flagged: data.flagged,
						nsfw: data.categories.nsfw,
						specialCare: data.categories.special_care,
					},
				},
			};
		} catch {
			return result("ERROR", "MODERATION_UNAVAILABLE");
		}
	}
	private async call(path: string, init: RequestInit) {
		if (!this.options.apiKey.trim()) throw new Error("MODERATION_CONFIGURATION_ERROR");
		const headers = new Headers(init.headers);
		headers.set("Authorization", `Bearer ${this.options.apiKey}`);
		headers.set("Content-Type", "application/json");
		const response = await fetchJson(
			`https://api.seeapi.com${path}`,
			{
				...init,
				redirect: "error",
				headers,
			},
			{ maxResponseBytes: 64 * 1024, ...this.options },
		);
		if (!response.ok) throw new Error("MODERATION_UNAVAILABLE");
		return taskSchema.parse(response.data);
	}
}
