import { createVideoVisualSafetyProfile } from "@repo/config/video-safety";
import { describe, expect, it, vi } from "vitest";

import officialFixture from "../catalog/fixtures/seeapi-video-moderation-contract-2026-10-04.json";
import { SeeapiVideoSafetyAdapter } from "./seeapi-video";

function visualProfile(durationSeconds = 5) {
	const profile = createVideoVisualSafetyProfile("seeapi", durationSeconds);
	if (profile.provider !== "seeapi") throw new Error("TEST_PROFILE_MISMATCH");
	return profile;
}

const input = {
	assetUrl: "https://private.example/video.mp4?signed=private",
	callbackUrl: "https://app.example/api/webhooks/video/moderation/seeapi/task-bound-token",
	ruleVersion: visualProfile().ruleVersion,
	visualSafetyProfile: visualProfile(),
	idempotencyKey: "immutable-verification-1",
	video: { durationMillis: 5000, audioTrackIds: [2] },
};
const lookup = { ...input, moderationTaskId: "task_video_1" };
// Synthetic complete reports exercise our acceptance policy; not real SeeAPI responses.
function completed(durationMillis = 5000, requestedSeconds = Math.ceil(durationMillis / 1000)) {
	const count = visualProfile(requestedSeconds).sampling.numFrames;
	return {
		id: "task_video_1",
		object: "inference",
		model: "video-nsfw-filter",
		endpoint: "video-moderation",
		provider: "seeapi",
		status: "succeeded",
		result: {
			type: "json",
			data: {
				flagged: false,
				output: {
					nsfw_detected: false,
					scope: "sampled_frames",
					sampling_complete: true,
					checked_frames: count,
					timestamp_source: "frame_index_div_fps_estimate",
					output_layout: "named-files-v1",
					report_schema_version: 5,
					flagged_frame_count: 0,
					frames: Array.from({ length: count }, (_, i) => ({
						frame_number: 1 + i * 17,
						timestamp_seconds: (i * durationMillis) / 1000 / (count - 1),
						nsfw_detected: false,
						nsfw: [] as string[],
						special: [] as string[] | undefined,
					})),
				},
			},
		},
		error: null,
	};
}
function pending(status = "processing") {
	return { ...completed(), status, result: null };
}
function fixture(
	body: unknown = completed(),
	status = 200,
	options: { maxResponseBytes?: number; apiKey?: string } = {},
) {
	const fetcher = vi.fn<typeof fetch>(async () => Response.json(body, { status }));
	return {
		fetcher,
		adapter: new SeeapiVideoSafetyAdapter({ apiKey: "fixture-secret", fetch: fetcher, ...options }),
	};
}

describe("SeeAPI sampled video visual review", () => {
	it("preserves the official inference wire example and does not inflate its illustrative one-frame report", async () => {
		const accepted = fixture(
			officialFixture.acceptanceResponse.body,
			officialFixture.acceptanceResponse.statusCode,
		);
		expect(await accepted.adapter.submitVideo(input)).toMatchObject({
			moderationTaskId: "task_xxx",
		});
		const report = await fixture(
			officialFixture.illustrativeOneFrameQueryResponse,
		).adapter.retrieveVideo({ ...lookup, moderationTaskId: "task_xxx" });
		expect(report.decision).toBe("ERROR");
		expect(officialFixture.query.url).toBe("https://api.seeapi.com/v1/inferences/{task_id}");
	});
	it.each([
		[2000, 8],
		[5000, 8],
		[8000, 10],
		[15000, 17],
		[29900, 32],
		[30000, 32],
	])("freezes requested duration %ims using %i frames", (duration, expected) => {
		expect(visualProfile(Math.ceil(duration / 1000)).sampling.numFrames).toBe(expected);
	});
	it.each([0, -1, 30_001, 30_250, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
		"rejects unsupported actual duration %s before sending",
		async (duration) => {
			const { adapter, fetcher } = fixture();
			await expect(
				adapter.submitVideo({ ...input, video: { ...input.video, durationMillis: duration } }),
			).rejects.toThrow("MODERATION_INVALID_INPUT");
			expect(fetcher).not.toHaveBeenCalled();
		},
	);
	it("submits the real inference route once with strict image-aligned parameters", async () => {
		const { adapter, fetcher } = fixture(pending(), 202);
		const submitted = await adapter.submitVideo(input);
		expect(submitted).toEqual({
			moderationTaskId: "task_video_1",
			status: "RUNNING",
			ruleVersion: input.ruleVersion,
			idempotency: { key: input.idempotencyKey, providerSupported: true, replayed: false },
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
		const [url, request] = fetcher.mock.calls[0]!;
		expect(url).toBe("https://api.seeapi.com/v1/inferences");
		expect(request?.redirect).toBe("manual");
		expect(new Headers(request?.headers).get("Idempotency-Key")).toBe(input.idempotencyKey);
		expect(new Headers(request?.headers).get("Authorization")).toBe("Bearer fixture-secret");
		expect(JSON.parse(request?.body as string)).toEqual({
			model: "video-nsfw-filter",
			endpoint: "video-moderation",
			provider: "seeapi",
			input: {
				video_url: input.assetUrl,
				num_frames: 8,
				threshold_offset: 0,
				strict_special_care: true,
				return_frames: "none",
			},
			callback_url: input.callbackUrl,
		});
		expect(submitted.completedDecision).toBeUndefined();
	});
	it.each([
		undefined,
		"",
		"not a URL",
		"http://app.example/callback",
		"https://user:password@app.example/callback",
		"https://app.example/callback#fragment",
		" https://app.example/callback",
		"https://app.example/call\nback",
		`https://app.example/${"x".repeat(2048)}`,
	])("rejects missing/unsafe callback URL before submission", async (callbackUrl) => {
		const { adapter, fetcher } = fixture();
		await expect(adapter.submitVideo({ ...input, callbackUrl })).rejects.toThrow(
			"MODERATION_INVALID_INPUT",
		);
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("an immediate succeeded POST still requires authoritative GET verification", async () => {
		expect((await fixture().adapter.submitVideo(input)).completedDecision).toBeUndefined();
	});
	it("uses the frozen requested sample count when actual duration drifts", async () => {
		const drifted = {
			...lookup,
			visualSafetyProfile: visualProfile(8),
			video: { durationMillis: 8001, audioTrackIds: [] },
		};
		const { adapter, fetcher } = fixture(pending(), 202);
		await adapter.submitVideo({ ...input, ...drifted });
		expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string).input.num_frames).toBe(10);
		const accepted = await fixture(completed(8001, 8)).adapter.retrieveVideo(drifted);
		expect(accepted.decision).toBe("ALLOW");
		expect(accepted.evidence?.seeapiVideo?.requestedFrames).toBe(10);
		expect(accepted.evidence?.seeapiVideo?.maxFrameGapSeconds).toBeCloseTo(8.001 / 9);
	});
	it.each([
		{ visualSafetyProfile: undefined },
		{ visualSafetyProfile: createVideoVisualSafetyProfile("sightengine", 5) },
		{ ruleVersion: "unrelated-policy" },
		{
			visualSafetyProfile: {
				...visualProfile(),
				sampling: { ...visualProfile().sampling, thresholdOffset: 0.1 },
			},
		},
		{
			visualSafetyProfile: {
				...visualProfile(),
				sampling: { ...visualProfile().sampling, maxFrameGapMillis: 2000 },
			},
		},
	])("fails closed before sending with an absent/mismatched/loosened profile", async (patch) => {
		const altered = { ...input, ...patch } as typeof input;
		const { adapter, fetcher } = fixture();
		await expect(adapter.submitVideo(altered)).rejects.toThrow("MODERATION_INVALID_INPUT");
		expect(
			await adapter.retrieveVideo({ ...altered, moderationTaskId: "task_video_1" }),
		).toMatchObject({ decision: "ERROR" });
		expect(fetcher).not.toHaveBeenCalled();
	});
	it.each([2000, 5000, 10_000, 15_000, 30_000])(
		"validates a complete sampled timeline for %ims without claiming audio/full-frame review",
		async (durationMillis) => {
			const { adapter, fetcher } = fixture(completed(durationMillis));
			const result = await adapter.retrieveVideo({
				...lookup,
				visualSafetyProfile: visualProfile(durationMillis / 1000),
				video: { durationMillis, audioTrackIds: [2] },
			});
			expect(result).toMatchObject({
				decision: "ALLOW",
				evidence: {
					models: ["video-nsfw-filter"],
					video: {
						complete: true,
						durationMillis,
						frameCount: visualProfile(durationMillis / 1000).sampling.numFrames,
					},
					seeapiVideo: {
						scope: "sampled_frames",
						samplingComplete: true,
						thresholdOffset: 0,
						strictSpecialCare: true,
						returnFrames: "none",
					},
				},
			});
			expect(result.evidence?.audio).toBeUndefined();
			expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.seeapi.com/v1/inferences/task_video_1");
			expect(fetcher.mock.calls[0]?.[1]?.method).toBe("GET");
			expect(JSON.stringify(result)).not.toMatch(/fixture-secret|signed=private|image_url/);
		},
	);
	it.each(["queued", "processing"])("keeps %s pending without a clean verdict", async (status) => {
		expect(await fixture(pending(status)).adapter.retrieveVideo(lookup)).toMatchObject({
			decision: "REVIEW",
			reasonCode: "VIDEO_PROCESSING",
		});
	});
	it.each(["failed", "canceled"] as const)(
		"classifies terminal task %s as nontransient with or without error details",
		async (status) => {
			for (const error of [null, { code: "provider-failure", message: "private diagnostic" }]) {
				const { adapter, fetcher } = fixture({ ...pending(status), error });
				expect(await adapter.retrieveVideo(lookup)).toEqual({
					decision: "ERROR",
					reasonCode:
						status === "failed" ? "VIDEO_MODERATION_TASK_FAILED" : "VIDEO_MODERATION_TASK_CANCELED",
					ruleVersion: input.ruleVersion,
				});
				expect(fetcher).toHaveBeenCalledTimes(1);
			}
		},
	);
	it("rejects a normal flagged report and deduplicates labels", async () => {
		const body = completed();
		body.result.data.flagged = true;
		const report = body.result.data.output;
		report.nsfw_detected = true;
		report.flagged_frame_count = 2;
		for (const frame of report.frames.slice(0, 2)) {
			frame.nsfw_detected = true;
			frame.nsfw = ["label"];
			frame.special = ["special-label"];
		}
		expect(await fixture(body).adapter.retrieveVideo(lookup)).toMatchObject({
			decision: "REJECT",
			reasonCode: "SEEAPI_CONTENT_NOT_ALLOWED",
			evidence: {
				seeapiVideo: { flaggedFrameCount: 2, nsfw: ["label"], specialCare: ["special-label"] },
			},
		});
	});
	it("rejects billable content_policy_blocked without inventing a frame report", async () => {
		const body = {
			...completed(),
			result: {
				type: "json",
				data: {
					flagged: true,
					output: null,
					reason: "content_policy_blocked",
					message: "policy message",
				},
			},
		};
		expect(await fixture(body).adapter.retrieveVideo(lookup)).toEqual({
			decision: "REJECT",
			reasonCode: "SEEAPI_CONTENT_NOT_ALLOWED",
			ruleVersion: input.ruleVersion,
		});
	});
	it("accepts officially optional special/image fields without claiming returned empty categories", async () => {
		const body = completed();
		for (const frame of body.result.data.output.frames) delete frame.special;
		const result = await fixture(body).adapter.retrieveVideo(lookup);
		expect(result.decision).toBe("ALLOW");
		expect(result.evidence?.seeapiVideo?.specialCare).toBeUndefined();
		expect(result.evidence?.seeapiVideo?.specialCareReportedFrames).toBe(0);
	});
	it.each(["nsfw", "special"] as const)(
		"retains image policy REVIEW for nonempty %s labels with flagged=false",
		async (field) => {
			const body = completed();
			body.result.data.output.frames[2]![field] = ["review-label"];
			expect(await fixture(body).adapter.retrieveVideo(lookup)).toMatchObject({
				decision: "REVIEW",
				reasonCode: "SEEAPI_CONTENT_REVIEW",
			});
		},
	);
	it.each([
		[
			"wrong task",
			(body: ReturnType<typeof completed>) => {
				body.id = "task_other";
			},
		],
		[
			"wrong model",
			(body: ReturnType<typeof completed>) => {
				body.model = "nsfw-filter";
			},
		],
		[
			"wrong endpoint",
			(body: ReturnType<typeof completed>) => {
				body.endpoint = "image-moderation";
			},
		],
		[
			"wrong provider",
			(body: ReturnType<typeof completed>) => {
				body.provider = "other";
			},
		],
		[
			"wrong object",
			(body: ReturnType<typeof completed>) => {
				body.object = "generation";
			},
		],
		[
			"not completed",
			(body: ReturnType<typeof completed>) => {
				body.result.data.output.sampling_complete = false;
			},
		],
		[
			"wrong count",
			(body: ReturnType<typeof completed>) => {
				body.result.data.output.checked_frames--;
			},
		],
		[
			"insufficient frames",
			(body: ReturnType<typeof completed>) => {
				body.result.data.output.frames.pop();
				body.result.data.output.checked_frames--;
			},
		],
		[
			"mismatched overall verdict",
			(body: ReturnType<typeof completed>) => {
				body.result.data.output.nsfw_detected = true;
			},
		],
		[
			"mismatched frame verdict",
			(body: ReturnType<typeof completed>) => {
				body.result.data.output.frames[1]!.nsfw_detected = true;
			},
		],
		[
			"wrong flagged count",
			(body: ReturnType<typeof completed>) => {
				body.result.data.output.flagged_frame_count = 1;
			},
		],
		[
			"wrong schema",
			(body: ReturnType<typeof completed>) => {
				body.result.data.output.report_schema_version = 4;
			},
		],
		[
			"wrong scope",
			(body: ReturnType<typeof completed>) => {
				body.result.data.output.scope = "full_video";
			},
		],
		[
			"unknown timestamp semantics",
			(body: ReturnType<typeof completed>) => {
				body.result.data.output.timestamp_source = "unknown";
			},
		],
		[
			"wrong layout",
			(body: ReturnType<typeof completed>) => {
				body.result.data.output.output_layout = "unknown";
			},
		],
		[
			"duplicate source frame",
			(body: ReturnType<typeof completed>) => {
				body.result.data.output.frames[1]!.frame_number = 1;
			},
		],
		[
			"duplicate timestamp",
			(body: ReturnType<typeof completed>) => {
				body.result.data.output.frames[1]!.timestamp_seconds = 0;
			},
		],
		[
			"timestamp after duration",
			(body: ReturnType<typeof completed>) => {
				body.result.data.output.frames[7]!.timestamp_seconds = 10;
			},
		],
		[
			"missing final coverage",
			(body: ReturnType<typeof completed>) => {
				for (const frame of body.result.data.output.frames) frame.timestamp_seconds /= 2;
			},
		],
		[
			"missing opening coverage",
			(body: ReturnType<typeof completed>) => {
				for (const frame of body.result.data.output.frames)
					frame.timestamp_seconds = 2 + frame.timestamp_seconds / 2;
			},
		],
		[
			"large interior gap",
			(body: ReturnType<typeof completed>) => {
				for (const [i, frame] of body.result.data.output.frames.entries())
					frame.timestamp_seconds = i < 4 ? i * 0.1 : 4.7 + (i - 4) * 0.1;
			},
		],
	] as const)("fails closed: %s", async (_label, mutate) => {
		const body = completed();
		mutate(body);
		expect(await fixture(body).adapter.retrieveVideo(lookup)).toMatchObject({ decision: "ERROR" });
	});
	it.each([
		{
			...completed(),
			status: "failed",
			result: null,
			error: { code: "remote", message: "signed=private fixture-secret" },
		},
		{ ...completed(), status: "canceled", result: null },
		{ ...completed(), result: null },
		{ ...pending(), result: completed().result },
		{
			...completed(),
			result: {
				type: "json",
				data: { flagged: false, output: null, reason: "content_policy_blocked" },
			},
		},
		{ ...completed(), result: { type: "json", data: { flagged: true, output: null } } },
	])("never approves malformed terminal or pending results", async (body) => {
		const result = await fixture(body).adapter.retrieveVideo(lookup);
		expect(result.decision).toBe("ERROR");
		expect(JSON.stringify(result)).not.toMatch(/fixture-secret|signed=private/);
	});
	it.each([301, 302, 303, 307, 308, 408, 409, 429, 500, 503])(
		"does not redirect or retry submission after HTTP %i",
		async (status) => {
			const { adapter, fetcher } = fixture({ private: input.assetUrl }, status);
			await expect(adapter.submitVideo(input)).rejects.toThrow(/^MODERATION_/);
			expect(fetcher).toHaveBeenCalledTimes(1);
			expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("manual");
		},
	);
	it("does not retry an unknown transport outcome or leak its raw error", async () => {
		const fetcher = vi.fn<typeof fetch>(async () => {
			throw new Error("fixture-secret signed=private");
		});
		const adapter = new SeeapiVideoSafetyAdapter({ apiKey: "fixture-secret", fetch: fetcher });
		await expect(adapter.submitVideo(input)).rejects.toThrow("MODERATION_UNAVAILABLE");
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it("bounds reports even when the injected options request a larger response", async () => {
		const { adapter } = fixture({ ...completed(), padding: "x".repeat(256 * 1024) }, 200, {
			maxResponseBytes: 1024 * 1024,
		});
		expect(await adapter.retrieveVideo(lookup)).toMatchObject({
			decision: "ERROR",
			reasonCode: "MODERATION_INVALID_RESPONSE",
		});
	});
	it("rejects missing trusted duration, invalid key, and unconfigured credentials before sending", async () => {
		const { adapter, fetcher } = fixture();
		await expect(adapter.submitVideo({ ...input, video: undefined })).rejects.toThrow(
			"MODERATION_INVALID_INPUT",
		);
		await expect(adapter.submitVideo({ ...input, idempotencyKey: "" })).rejects.toThrow(
			"MODERATION_INVALID_INPUT",
		);
		await expect(
			adapter.submitVideo({ ...input, assetUrl: "http://private.example/file" }),
		).rejects.toThrow("MODERATION_INVALID_INPUT");
		expect(fetcher).not.toHaveBeenCalled();
		const missing = fixture(completed(), 200, { apiKey: "" });
		await expect(missing.adapter.submitVideo(input)).rejects.toThrow(
			"MODERATION_CONFIGURATION_ERROR",
		);
		expect(missing.fetcher).not.toHaveBeenCalled();
	});
});
