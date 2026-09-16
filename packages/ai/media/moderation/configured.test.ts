import { afterEach, describe, expect, it, vi } from "vitest";

import { createConfiguredImageSafetyAdapter } from "./configured";
import { safeImageResponse } from "./sightengine.test-fixtures";

const environment = {
	NODE_ENV: "production",
	MEDIA_SAFETY_ADAPTER: "configured",
	MODERATION_IMAGE_SEEAPI_ENABLED: "true",
	MODERATION_IMAGE_SIGHTENGINE_ENABLED: "false",
	SEEAPI_API_KEY: "fixture",
	SIGHTENGINE_API_USER: "fixture",
	SIGHTENGINE_API_SECRET: "fixture",
};
const input = {
	assetUrl: "https://private.example/image.png",
	ruleVersion: "rule",
	moderationTaskId: "task_fixture",
};
afterEach(() => vi.unstubAllGlobals());

function responses(flagged = false) {
	const fetcher = vi.fn<typeof fetch>(async (url) =>
		new URL(url instanceof Request ? url.url : url).hostname === "api.seeapi.com"
			? Response.json({
					id: input.moderationTaskId,
					object: "inference",
					model: "nsfw-filter",
					endpoint: "image-moderation",
					provider: "seeapi",
					status: "succeeded",
					error: null,
					result: { type: "json", data: { flagged, categories: { nsfw: [], special_care: [] } } },
				})
			: Response.json(safeImageResponse()),
	);
	vi.stubGlobal("fetch", fetcher);
	return fetcher;
}

describe("configured image moderation", () => {
	it("calls only SeeAPI when Sightengine is disabled", async () => {
		const fetcher = responses();
		const adapter = createConfiguredImageSafetyAdapter({
			...environment,
			SIGHTENGINE_API_USER: "",
			SIGHTENGINE_API_SECRET: "",
		});
		expect(await adapter.retrieveImage!(input)).toMatchObject({ decision: "ALLOW" });
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(fetcher.mock.calls[0]![0]).toEqual(expect.stringContaining("api.seeapi.com"));
	});
	it("runs both enabled checks and retains their evidence", async () => {
		const fetcher = responses();
		const adapter = createConfiguredImageSafetyAdapter({
			...environment,
			MODERATION_IMAGE_SIGHTENGINE_ENABLED: "true",
		});
		expect(await adapter.retrieveImage!(input)).toMatchObject({
			decision: "ALLOW",
			evidence: {
				seeapi: { flagged: false },
				models: expect.arrayContaining(["nsfw-filter", "nudity-2.1"]),
			},
		});
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
	it("stops at a primary rejection without paying for a secondary check", async () => {
		const fetcher = responses(true);
		const adapter = createConfiguredImageSafetyAdapter({
			...environment,
			MODERATION_IMAGE_SIGHTENGINE_ENABLED: "true",
		});
		expect(await adapter.retrieveImage!(input)).toMatchObject({ decision: "REJECT" });
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it("uses Sightengine alone without requiring a SeeAPI key", async () => {
		const fetcher = responses();
		const adapter = createConfiguredImageSafetyAdapter({
			...environment,
			MODERATION_IMAGE_SEEAPI_ENABLED: "false",
			MODERATION_IMAGE_SIGHTENGINE_ENABLED: "true",
			SEEAPI_API_KEY: "",
		});
		expect("submitImage" in adapter).toBe(false);
		expect(await adapter.moderateImage(input)).toMatchObject({ decision: "ALLOW" });
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(fetcher.mock.calls[0]![0]).toEqual(expect.stringContaining("sightengine.com"));
	});
	it("never approves all-off configuration or a production test adapter", async () => {
		const fetcher = responses();
		for (const env of [
			{ ...environment, MODERATION_IMAGE_SEEAPI_ENABLED: "false" },
			{ NODE_ENV: "production", MEDIA_SAFETY_ADAPTER: "test" },
		]) {
			expect(await createConfiguredImageSafetyAdapter(env).moderateImage(input)).toMatchObject({
				decision: "ERROR",
			});
		}
		expect(fetcher).not.toHaveBeenCalled();
	});
});
