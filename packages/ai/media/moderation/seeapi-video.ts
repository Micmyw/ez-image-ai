import { moderationHttpErrorCode, moderationServiceErrorCode } from "@repo/config";
import { videoVisualSafetyProfileSchema } from "@repo/config/video-safety";
import { z } from "zod";

import { fetchJson, type HttpClientOptions } from "../providers/http";
import type {
	ModerationDecision,
	ModerationSubmission,
	RetrieveModerationInput,
	SubmitVideoInput,
} from "./types";

const MODEL = "video-nsfw-filter";
const MAX_RESPONSE_BYTES = 256 * 1024;
const taskIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const labelSchema = z
	.string()
	.trim()
	.min(1)
	.max(128)
	.refine(
		(value) =>
			!Array.from(value).some(
				(character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
			),
	);
const envelopeSchema = z.object({
	id: taskIdSchema,
	object: z.literal("inference"),
	model: z.literal(MODEL),
	endpoint: z.literal("video-moderation"),
	provider: z.literal("seeapi"),
	status: z.enum(["queued", "processing", "succeeded", "failed", "canceled"]),
	result: z.unknown(),
	error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
const frameSchema = z.object({
	frame_number: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	timestamp_seconds: z.number().finite().nonnegative(),
	nsfw_detected: z.boolean(),
	nsfw: z.array(labelSchema).max(100),
	// The official contract explicitly permits omission, even with strict_special_care=true.
	special: z.array(labelSchema).max(100).optional(),
});
const resultSchema = z.object({
	type: z.literal("json"),
	data: z.object({
		flagged: z.boolean(),
		output: z
			.object({
				nsfw_detected: z.boolean(),
				scope: z.literal("sampled_frames"),
				sampling_complete: z.boolean(),
				checked_frames: z.number().int().min(1).max(32),
				timestamp_source: z.literal("frame_index_div_fps_estimate"),
				output_layout: z.literal("named-files-v1"),
				report_schema_version: z.literal(5),
				flagged_frame_count: z.number().int().min(0).max(32),
				frames: z.array(frameSchema).min(1).max(32),
			})
			.nullable(),
		reason: z.literal("content_policy_blocked").optional(),
		message: z.string().max(4096).optional(),
	}),
});

function videoInput(input: SubmitVideoInput | RetrieveModerationInput) {
	const parsed = videoVisualSafetyProfileSchema.safeParse(input.visualSafetyProfile);
	if (
		!parsed.success ||
		parsed.data.provider !== "seeapi" ||
		input.ruleVersion !== parsed.data.ruleVersion ||
		!input.video ||
		!Number.isInteger(input.video.durationMillis) ||
		input.video.durationMillis < 1 ||
		input.video.durationMillis > 30_000
	)
		throw new Error("MODERATION_INVALID_INPUT");
	return {
		durationMillis: input.video.durationMillis,
		requestedFrames: parsed.data.sampling.numFrames,
		sampling: parsed.data.sampling,
	};
}

function decision(
	input: RetrieveModerationInput,
	value: ModerationDecision["decision"],
	reasonCode: string,
): ModerationDecision {
	return { decision: value, reasonCode, ruleVersion: input.ruleVersion };
}

/**
 * Video NSFW / special-care assessment uses the same strict settings as SeeAPI images.
 * The caller durably fences submission and binds task ID to the immutable asset hash/ETag.
 * No submission retry is performed, including after uncertain transport/HTTP outcomes.
 */
export class SeeapiVideoSafetyAdapter {
	constructor(private readonly options: HttpClientOptions & { apiKey: string }) {}

	async submitVideo(input: SubmitVideoInput): Promise<ModerationSubmission> {
		try {
			const { requestedFrames, sampling } = videoInput(input);
			let url: URL;
			let callback: URL;
			try {
				url = new URL(input.assetUrl);
				if (!input.callbackUrl) throw new Error("MODERATION_INVALID_INPUT");
				callback = new URL(input.callbackUrl);
			} catch {
				throw new Error("MODERATION_INVALID_INPUT");
			}
			if (
				url.protocol !== "https:" ||
				url.username ||
				url.password ||
				url.hash ||
				input.assetUrl.length > 8192 ||
				!input.idempotencyKey.trim() ||
				input.idempotencyKey.length > 255
			)
				throw new Error("MODERATION_INVALID_INPUT");
			// The caller constructs this task-bound URL on the server and must not
			// accept client-selected destinations. This integration requires callbacks.
			if (
				callback.protocol !== "https:" ||
				callback.username ||
				callback.password ||
				callback.hash ||
				input.callbackUrl.length > 2048 ||
				input.callbackUrl.trim() !== input.callbackUrl ||
				Array.from(input.callbackUrl).some(
					(character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
				)
			)
				throw new Error("MODERATION_INVALID_INPUT");
			const task = await this.call("/v1/inferences", {
				method: "POST",
				headers: { "Idempotency-Key": input.idempotencyKey },
				body: JSON.stringify({
					model: MODEL,
					endpoint: "video-moderation",
					provider: "seeapi",
					callback_url: input.callbackUrl,
					input: {
						video_url: input.assetUrl,
						num_frames: requestedFrames,
						threshold_offset: sampling.thresholdOffset,
						strict_special_care: sampling.strictSpecialCare,
						return_frames: sampling.returnFrames,
					},
				}),
			});
			if (
				task.error !== null ||
				!["queued", "processing", "succeeded"].includes(task.status) ||
				((task.status === "queued" || task.status === "processing") && task.result !== null)
			)
				throw new Error("MODERATION_INVALID_RESPONSE");
			// Even an immediately finished POST is confirmed by the authoritative GET.
			return {
				moderationTaskId: task.id,
				status: task.status === "queued" ? "QUEUED" : "RUNNING",
				ruleVersion: input.ruleVersion,
				idempotency: { key: input.idempotencyKey, providerSupported: true, replayed: false },
			};
		} catch (error) {
			throw new Error(moderationServiceErrorCode(error));
		}
	}

	async retrieveVideo(input: RetrieveModerationInput): Promise<ModerationDecision> {
		try {
			const { durationMillis, requestedFrames, sampling } = videoInput(input);
			if (!taskIdSchema.safeParse(input.moderationTaskId).success)
				throw new Error("MODERATION_INVALID_INPUT");
			const task = await this.call(`/v1/inferences/${encodeURIComponent(input.moderationTaskId)}`, {
				method: "GET",
			});
			if (task.id !== input.moderationTaskId)
				return decision(input, "ERROR", "MODERATION_INVALID_RESPONSE");
			if (task.status === "failed") return decision(input, "ERROR", "VIDEO_MODERATION_TASK_FAILED");
			if (task.status === "canceled")
				return decision(input, "ERROR", "VIDEO_MODERATION_TASK_CANCELED");
			if (task.error !== null) return decision(input, "ERROR", "MODERATION_INVALID_RESPONSE");
			if (task.status === "queued" || task.status === "processing")
				return task.result === null
					? decision(input, "REVIEW", "VIDEO_PROCESSING")
					: decision(input, "ERROR", "MODERATION_INVALID_RESPONSE");
			if (task.status !== "succeeded")
				return decision(input, "ERROR", "MODERATION_INVALID_RESPONSE");
			const data = resultSchema.parse(task.result).data;
			if (data.output === null)
				return data.flagged && data.reason === "content_policy_blocked"
					? decision(input, "REJECT", "SEEAPI_CONTENT_NOT_ALLOWED")
					: decision(input, "ERROR", "MODERATION_INVALID_RESPONSE");
			const report = data.output;
			const frames = report.frames;
			const flaggedCount = frames.filter((frame) => frame.nsfw_detected).length;
			if (
				data.reason ||
				!report.sampling_complete ||
				report.checked_frames !== requestedFrames ||
				frames.length !== report.checked_frames ||
				report.nsfw_detected !== data.flagged ||
				flaggedCount !== report.flagged_frame_count ||
				data.flagged !== flaggedCount > 0
			)
				return decision(input, "ERROR", "MODERATION_INVALID_RESPONSE");
			const durationSeconds = durationMillis / 1000;
			// Conservative application coverage of the sample timeline, not inferred FPS.
			let maxFrameGapSeconds = 0;
			for (const [index, frame] of frames.entries()) {
				const previous = frames[index - 1];
				if (previous)
					maxFrameGapSeconds = Math.max(
						maxFrameGapSeconds,
						frame.timestamp_seconds - previous.timestamp_seconds,
					);
				if (
					frame.timestamp_seconds > durationSeconds + sampling.maxEndOverrunMillis / 1000 ||
					(previous &&
						(frame.frame_number <= previous.frame_number ||
							frame.timestamp_seconds <= previous.timestamp_seconds ||
							maxFrameGapSeconds > sampling.maxFrameGapMillis / 1000))
				)
					return decision(input, "ERROR", "VIDEO_MODERATION_INCOMPLETE");
			}
			const first = frames[0]!;
			const last = frames[frames.length - 1]!;
			if (
				first.timestamp_seconds > sampling.maxFirstFrameMillis / 1000 ||
				last.timestamp_seconds < durationSeconds - sampling.maxLastFrameGapMillis / 1000
			)
				return decision(input, "ERROR", "VIDEO_MODERATION_INCOMPLETE");
			const nsfw = [...new Set(frames.flatMap((frame) => frame.nsfw))];
			const specialCare = [...new Set(frames.flatMap((frame) => frame.special ?? []))];
			const specialCareReportedFrames = frames.filter(
				(frame) => frame.special !== undefined,
			).length;
			const outcome = data.flagged
				? "REJECT"
				: nsfw.length || specialCare.length
					? "REVIEW"
					: "ALLOW";
			return {
				...decision(
					input,
					outcome,
					outcome === "REJECT"
						? "SEEAPI_CONTENT_NOT_ALLOWED"
						: outcome === "REVIEW"
							? "SEEAPI_CONTENT_REVIEW"
							: "NO_POLICY_MATCH",
				),
				evidence: {
					requestId: task.id,
					models: [MODEL],
					operations: 1,
					scores: {},
					video: {
						complete: true,
						durationMillis,
						frameCount: frames.length,
						firstFrameSeconds: first.timestamp_seconds,
						lastFrameSeconds: last.timestamp_seconds,
					},
					seeapiVideo: {
						taskId: task.id,
						model: MODEL,
						scope: report.scope,
						samplingComplete: true,
						requestedFrames,
						checkedFrames: report.checked_frames,
						timestampSource: report.timestamp_source,
						reportSchemaVersion: report.report_schema_version,
						thresholdOffset: sampling.thresholdOffset,
						strictSpecialCare: sampling.strictSpecialCare,
						returnFrames: sampling.returnFrames,
						flagged: data.flagged,
						flaggedFrameCount: flaggedCount,
						maxFrameGapSeconds,
						nsfw,
						...(specialCareReportedFrames ? { specialCare } : {}),
						specialCareReportedFrames,
					},
				},
			};
		} catch (error) {
			return decision(input, "ERROR", moderationServiceErrorCode(error));
		}
	}

	private async call(path: string, init: RequestInit) {
		if (!this.options.apiKey.trim()) throw new Error("MODERATION_CONFIGURATION_ERROR");
		const headers = new Headers(init.headers);
		headers.set("Authorization", `Bearer ${this.options.apiKey.trim()}`);
		headers.set("Content-Type", "application/json");
		const response = await fetchJson(
			`https://api.seeapi.com${path}`,
			{ ...init, redirect: "manual", headers },
			{
				...this.options,
				maxResponseBytes: Math.min(
					this.options.maxResponseBytes ?? MAX_RESPONSE_BYTES,
					MAX_RESPONSE_BYTES,
				),
			},
		);
		if (!response.ok) throw new Error(moderationHttpErrorCode(response.status));
		return envelopeSchema.parse(response.data);
	}
}
