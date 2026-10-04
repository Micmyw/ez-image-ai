import type { SubmitVideoInput } from "@repo/ai/media/moderation/types";
import { createConfiguredVideoSafetyAdapter } from "@repo/ai/media/moderation/video-configured";
import { createVideoVisualSafetyProfile } from "@repo/config/video-safety";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const upstream = (env as unknown as { SEEAPI_UPSTREAM: Fetcher }).SEEAPI_UPSTREAM;
const taskId = "seeapi_workerd_immutable_1";
const environment = {
	// The persisted profile must override a later environment/provider change.
	VIDEO_V1_VIDEO_SAFETY_ADAPTER: "sightengine",
	SEEAPI_API_KEY: "workerd-local-seeapi-fixture-not-a-real-key",
};
function setup(duration = 5, actualDurationMillis = duration * 1000) {
	const profile = createVideoVisualSafetyProfile("seeapi", duration);
	if (profile.provider !== "seeapi") throw new Error("TEST_PROFILE_MISMATCH");
	return {
		profile,
		// No fetch injection: production fetchJson uses actual workerd global fetch.
		adapter: createConfiguredVideoSafetyAdapter(environment, {}, profile),
		input: {
			assetUrl: "https://private-video.invalid/immutable.mp4?signed=local-fixture",
			callbackUrl:
				"https://callback-fixture.invalid/api/webhooks/video-moderation/seeapi?token=local-fixture",
			ruleVersion: profile.ruleVersion,
			idempotencyKey: "immutable-asset-checksum-etag-verification",
			video: { durationMillis: actualDurationMillis, audioTrackIds: [] },
		} satisfies SubmitVideoInput,
	};
}
async function reset(mode = "queued", durationMillis = 5000) {
	await upstream.fetch(
		`https://seeapi-fixture.invalid/__reset?mode=${mode}&duration=${durationMillis}`,
	);
}
async function state(): Promise<Record<string, unknown>> {
	return (await upstream.fetch("https://seeapi-fixture.invalid/__state")).json();
}

describe("SeeAPI video adapter in real local workerd", () => {
	beforeEach(() => reset());
	it("uses native POST and streamed GET of the same ID with immutable strict settings", async () => {
		const { adapter, input } = setup();
		const submitted = await adapter.submitVideo(input);
		expect(submitted).toMatchObject({ moderationTaskId: taskId, status: "QUEUED" });
		expect(submitted.completedDecision).toBeUndefined();
		expect(
			await adapter.retrieveVideo({ ...input, moderationTaskId: submitted.moderationTaskId }),
		).toMatchObject({
			decision: "ALLOW",
			ruleVersion: input.ruleVersion,
			evidence: {
				seeapiVideo: {
					taskId,
					requestedFrames: 8,
					checkedFrames: 8,
					thresholdOffset: 0,
					strictSpecialCare: true,
					returnFrames: "none",
					scope: "sampled_frames",
				},
			},
		});
		const received = await state();
		expect(received).toMatchObject({
			postCalls: 1,
			getCalls: 1,
			redirectCalls: 0,
			unexpectedCalls: 0,
			authorization: `Bearer ${environment.SEEAPI_API_KEY}`,
			idempotencyKey: input.idempotencyKey,
			contentType: "application/json",
			submitted: {
				model: "video-nsfw-filter",
				endpoint: "video-moderation",
				provider: "seeapi",
				callback_url: input.callbackUrl,
				input: {
					video_url: input.assetUrl,
					num_frames: 8,
					threshold_offset: 0,
					strict_special_care: true,
					return_frames: "none",
				},
			},
			requests: [
				{ method: "POST", url: "https://api.seeapi.com/v1/inferences" },
				{ method: "GET", url: `https://api.seeapi.com/v1/inferences/${taskId}` },
			],
		});
		expect(received.requestBytes).toBe(
			new TextEncoder().encode(JSON.stringify(received.submitted)).byteLength,
		);
	});
	it("requires authoritative GET even when the submitted inference already succeeded", async () => {
		await reset("immediate");
		const { adapter, input } = setup();
		const submitted = await adapter.submitVideo(input);
		expect(submitted.completedDecision).toBeUndefined();
		expect(await state()).toMatchObject({ postCalls: 1, getCalls: 0 });
		expect(
			await adapter.retrieveVideo({ ...input, moderationTaskId: submitted.moderationTaskId }),
		).toMatchObject({ decision: "ALLOW" });
		expect(await state()).toMatchObject({ postCalls: 1, getCalls: 1 });
	});
	it("keeps the cloned profile and requested frame count when source object and actual duration change", async () => {
		await reset("queued", 8001);
		const { adapter, input, profile } = setup(8, 8001);
		profile.sampling.numFrames = 20;
		const submitted = await adapter.submitVideo(input);
		expect(
			await adapter.retrieveVideo({ ...input, moderationTaskId: submitted.moderationTaskId }),
		).toMatchObject({
			decision: "ALLOW",
			evidence: { seeapiVideo: { requestedFrames: 10, checkedFrames: 10 } },
		});
		expect(await state()).toMatchObject({ postCalls: 1, submitted: { input: { num_frames: 10 } } });
	});
	it("rejects an input profile different from the immutable factory profile before native fetch", async () => {
		const { adapter, input } = setup();
		await expect(
			adapter.submitVideo({
				...input,
				visualSafetyProfile: createVideoVisualSafetyProfile("seeapi", 10),
			}),
		).rejects.toThrow("VIDEO_SAFETY_PROFILE_INVALID");
		expect(await state()).toMatchObject({ postCalls: 0, getCalls: 0, unexpectedCalls: 0 });
	});
	it.each(["post-503", "malformed", "post-redirect"])(
		"never automatically repeats the paid POST after %s",
		async (mode) => {
			await reset(mode);
			const { adapter, input } = setup();
			await expect(adapter.submitVideo(input)).rejects.toThrow(/^MODERATION_/);
			expect(await state()).toMatchObject({
				postCalls: 1,
				getCalls: 0,
				redirectCalls: 0,
				unexpectedCalls: 0,
			});
		},
	);
	it("uses manual GET redirects and never falls back to another inference or paid submission", async () => {
		await reset("get-redirect");
		const { adapter, input } = setup();
		const submitted = await adapter.submitVideo(input);
		expect(
			await adapter.retrieveVideo({ ...input, moderationTaskId: submitted.moderationTaskId }),
		).toMatchObject({ decision: "ERROR" });
		expect(await state()).toMatchObject({
			postCalls: 1,
			getCalls: 1,
			redirectCalls: 0,
			unexpectedCalls: 0,
		});
	});
	it("rejects a streamed completed response for another inference ID", async () => {
		await reset("wrong-id");
		const { adapter, input } = setup();
		const submitted = await adapter.submitVideo(input);
		expect(
			await adapter.retrieveVideo({ ...input, moderationTaskId: submitted.moderationTaskId }),
		).toMatchObject({ decision: "ERROR", reasonCode: "MODERATION_INVALID_RESPONSE" });
		expect(await state()).toMatchObject({ postCalls: 1, getCalls: 1, unexpectedCalls: 0 });
	});
});
