import { describe, expect, it } from "vitest";

import {
	createMediaSafetyAdapter,
	SightengineSafetyAdapter,
	TestMediaSafetyAdapter,
} from "./index";
import { safeImageResponse, safeTextResponse } from "./sightengine.test-fixtures";

function fixtureFetch(...bodies: unknown[]): typeof fetch {
	let index = 0;
	return (async () =>
		new Response(JSON.stringify(bodies[index++]), { status: 200 })) as typeof fetch;
}

describe("media safety contract", () => {
	it("normalizes complete text and image decisions", async () => {
		const rejectedImage = safeImageResponse();
		rejectedImage.nudity.sexual_activity = 0.99;
		const adapter = new SightengineSafetyAdapter({
			apiUser: "user",
			apiSecret: "secret",
			fetch: fixtureFetch(safeTextResponse(), rejectedImage),
		});

		expect(
			await adapter.moderateText({ text: "A calm landscape", ruleVersion: "safety-1" }),
		).toMatchObject({ decision: "ALLOW", ruleVersion: "safety-1" });
		expect(
			await adapter.moderateImage({
				assetUrl: "https://cdn.test/image.png",
				ruleVersion: "safety-1",
			}),
		).toMatchObject({ decision: "REJECT", reasonCode: "SEXUAL_CONTENT" });
	});

	it("preserves legacy video submission identity without approving incomplete results", async () => {
		const adapter = new SightengineSafetyAdapter({
			apiUser: "user",
			apiSecret: "secret",
			fetch: fixtureFetch(
				{ status: "success", data: { id: "video-1" } },
				{ status: "success", data: { status: "processing" } },
				{ status: "success", data: { status: "finished", nudity: { sexual_activity: 0.01 } } },
			),
		});
		expect(
			await adapter.submitVideo({
				assetUrl: "https://cdn.test/video.mp4",
				ruleVersion: "safety-1",
				idempotencyKey: "moderation-video-1",
			}),
		).toMatchObject({
			moderationTaskId: "video-1",
			idempotency: {
				key: "moderation-video-1",
				providerSupported: false,
				replayed: false,
			},
		});
		expect(
			await adapter.retrieveVideo({ moderationTaskId: "video-1", ruleVersion: "safety-1" }),
		).toMatchObject({ decision: "REVIEW" });
		expect(
			await adapter.retrieveVideo({ moderationTaskId: "video-1", ruleVersion: "safety-1" }),
		).toMatchObject({ decision: "ERROR" });
	});

	it("rejects the test adapter in production", () => {
		expect(() => createMediaSafetyAdapter({ kind: "test", nodeEnv: "production" })).toThrow(
			/production/i,
		);
		expect(createMediaSafetyAdapter({ kind: "test", nodeEnv: "test" })).toBeInstanceOf(
			TestMediaSafetyAdapter,
		);
	});

	it("returns a non-sensitive ERROR decision when Sightengine is unavailable", async () => {
		const adapter = new SightengineSafetyAdapter({
			apiUser: "user",
			apiSecret: "secret",
			fetch: (async () => {
				throw new Error("network leaked-secret");
			}) as typeof fetch,
		});
		await expect(
			adapter.moderateImage({ assetUrl: "https://cdn.test/image.png", ruleVersion: "safety-1" }),
		).resolves.toEqual({
			decision: "ERROR",
			reasonCode: "MODERATION_UNAVAILABLE",
			ruleVersion: "safety-1",
		});
	});
});
