import { moderationHttpErrorCode, moderationServiceErrorCode } from "@repo/config";
import { z } from "zod";

import { fetchJson, type HttpClientOptions } from "../providers/http";
import type {
	ModerationDecision,
	ModerationSubmission,
	RetrieveModerationInput,
	SubmitVideoInput,
} from "./types";

const label = z.string().min(1).max(128);
const taskIdSchema = z
	.string()
	.min(1)
	.max(160)
	.refine((value) => !/[^A-Za-z0-9_-]/.test(value));
const taskSchema = z.object({
	id: taskIdSchema,
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
	error: z
		.object({
			code: z.string().min(1).max(128),
			message: z.string().max(4096),
		})
		.nullable(),
});

export class SeeapiSafetyAdapter {
	constructor(private readonly options: HttpClientOptions & { apiKey: string }) {}
	async submitImage(input: SubmitVideoInput): Promise<ModerationSubmission> {
		if (input.callbackUrl) {
			const callback = new URL(input.callbackUrl);
			if (
				callback.protocol !== "https:" ||
				callback.username ||
				callback.password ||
				callback.hash ||
				input.callbackUrl.length > 2048
			)
				throw new Error("MODERATION_INVALID_INPUT");
		}
		const task = await this.call("/v1/inferences", {
			method: "POST",
			headers: { "Idempotency-Key": input.idempotencyKey },
			body: JSON.stringify({
				model: "nsfw-filter",
				endpoint: "image-moderation",
				provider: "seeapi",
				...(input.callbackUrl ? { callback_url: input.callbackUrl } : {}),
				input: { image_url: input.assetUrl, threshold_offset: 0, strict_special_care: true },
			}),
		});
		if (!["queued", "processing", "succeeded", "failed"].includes(task.status))
			throw new Error("MODERATION_UNAVAILABLE");
		return {
			// A failed POST still identifies an accepted task. Preserve its binding
			// and require authenticated retrieval instead of losing it or resubmitting.
			moderationTaskId: task.id,
			...(task.status === "succeeded"
				? { completedDecision: completedTaskDecision(task, input.ruleVersion) }
				: {}),
			...((task.status === "queued" || task.status === "processing") && task.result === null
				? { nonterminalState: task.status }
				: {}),
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
			if (!taskIdSchema.safeParse(input.moderationTaskId).success)
				return result("ERROR", "MODERATION_INVALID_INPUT");
			const task = await this.call(`/v1/inferences/${encodeURIComponent(input.moderationTaskId)}`, {
				method: "GET",
			});
			if (task.id !== input.moderationTaskId) return result("ERROR", "MODERATION_INVALID_RESPONSE");
			if (task.status === "failed") {
				// Classify only validated machine codes; provider messages may contain
				// private media URLs and must never become diagnostics or policy verdicts.
				const reasonCode =
					task.error?.code === "MEDIA_INVALID"
						? "MODERATION_MEDIA_INVALID"
						: task.error?.code === "PROVIDER_TIMEOUT"
							? "MODERATION_TIMEOUT"
							: "MODERATION_UNAVAILABLE";
				return result("ERROR", reasonCode);
			}
			if (task.status === "queued" || task.status === "processing")
				return task.result === null
					? result("REVIEW", "IMAGE_PROCESSING")
					: result("ERROR", "MODERATION_INVALID_RESPONSE");
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
		} catch (error) {
			return result("ERROR", moderationServiceErrorCode(error));
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
				// Workers supports manual, not error. Non-2xx responses below still fail closed.
				redirect: "manual",
				headers,
			},
			{ maxResponseBytes: 64 * 1024, ...this.options },
		);
		if (!response.ok) throw new Error(moderationHttpErrorCode(response.status));
		const task = taskSchema.parse(response.data);
		if (
			(task.status === "failed" && task.result !== null) ||
			(task.status !== "failed" && task.error !== null)
		)
			throw new Error("MODERATION_INVALID_RESPONSE");
		return task;
	}
}

function completedTaskDecision(
	task: z.infer<typeof taskSchema>,
	ruleVersion: string,
): ModerationDecision {
	if (task.status !== "succeeded" || !task.result)
		return { decision: "ERROR", reasonCode: "MODERATION_INVALID_RESPONSE", ruleVersion };
	const data = task.result.data;
	const decision = data.flagged
		? "REJECT"
		: data.categories.nsfw.length || data.categories.special_care.length
			? "REVIEW"
			: "ALLOW";
	return {
		decision,
		reasonCode:
			decision === "REJECT"
				? "SEEAPI_CONTENT_NOT_ALLOWED"
				: decision === "REVIEW"
					? "SEEAPI_CONTENT_REVIEW"
					: "NO_POLICY_MATCH",
		ruleVersion,
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
}
