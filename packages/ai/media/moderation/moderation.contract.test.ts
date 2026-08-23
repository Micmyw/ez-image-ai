import { describe, expect, it } from "vitest";

import {
	createMediaSafetyAdapter,
	SightengineSafetyAdapter,
	TestMediaSafetyAdapter,
} from "./index";

function fixtureFetch(...bodies: unknown[]): typeof fetch {
	let index = 0;
	return (async () =>
		new Response(JSON.stringify(bodies[index++]), { status: 200 })) as typeof fetch;
}

describe("media safety contract", () => {
	it("normalizes text, image, asynchronous video, review, and error decisions", async () => {
		const adapter = new SightengineSafetyAdapter({
			apiUser: "user",
			apiSecret: "secret",
			fetch: fixtureFetch(
				{ status: "success", nudity: { sexual_activity: 0.01 }, weapon: 0.01 },
				{ status: "success", nudity: { sexual_activity: 0.99 } },
				{ status: "success", data: { id: "video-1" } },
				{ status: "success", data: { status: "finished", nudity: { sexual_activity: 0.6 } } },
			),
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
		expect(
			await adapter.submitVideo({
				assetUrl: "https://cdn.test/video.mp4",
				ruleVersion: "safety-1",
			}),
		).toMatchObject({ moderationTaskId: "video-1" });
		expect(
			await adapter.retrieveVideo({ moderationTaskId: "video-1", ruleVersion: "safety-1" }),
		).toMatchObject({ decision: "REVIEW" });
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
