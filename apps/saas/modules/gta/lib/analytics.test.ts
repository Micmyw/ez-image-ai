import {
	collectFirstTouchAttribution,
	sanitizeAttributionPath,
} from "@repo/utils/lib/acquisition-attribution-core";
import {
	analyticsPageLocation,
	growthAnalyticsPath,
	publicAnalyticsPath,
} from "@repo/utils/lib/analytics-page";
import {
	createBrowserGrowthAnalyticsDispatcher,
	growthAnalyticsEventSchema,
} from "@repo/utils/lib/growth-analytics";
import { afterEach, describe, expect, it, vi } from "vitest";

const send = vi.hoisted(() => vi.fn().mockResolvedValue("sent"));
vi.mock("@repo/utils/lib/growth-analytics-browser", () => ({
	trackBrowserGrowthEvent: send,
	registerBrowserGrowthAnalytics: vi.fn(),
	growthConsentRevision: () => 0,
}));

import { trackGtaToolEvent } from "./analytics";
import { defaultGtaSettings, GTA_PAGES, GTA_SCENES, type GtaSettings } from "./config";

const observation = {
	page: "/gta-6-wallpaper",
	theme: "gta-coastal",
	intent: "wallpaper",
	scene: "beach-sunset",
	sourceMode: "photo",
	ratio: "9:16",
	promptVersion: "gta-coastal-v1",
	stage: "tool_view",
};
const event = (imageTool: Record<string, unknown> = observation) => ({
	name: "public_image_tool_observed",
	properties: { imageTool },
});

afterEach(() => {
	send.mockReset().mockResolvedValue("sent");
});

describe("GTA public preset analytics", () => {
	it.each(GTA_SCENES)("accepts the finite scene $id without private data", ({ id }) => {
		expect(growthAnalyticsEventSchema.safeParse(event({ ...observation, scene: id })).success).toBe(
			true,
		);
	});

	it.each([
		{ prompt: "private prompt" },
		{ name: "private name" },
		{ taskId: "private-task" },
		{ sourceAssetId: "private-photo" },
		{ sourceUrl: "https://private.example/photo?signature=secret" },
		{ scene: "unpublished-scene" },
		{ page: "/gta-6-wallpaper?job=private" },
		{ intent: "loading-art" },
		{ ratio: "4k" },
		{ promptVersion: "future-version" },
		{ stage: "purchase_completed" },
	])("rejects extra or unbounded preset properties %j", (patch) => {
		expect(growthAnalyticsEventSchema.safeParse(event({ ...observation, ...patch })).success).toBe(
			false,
		);
	});

	it("binds the dedicated event to its observation shape and the loading page to photo input", () => {
		expect(
			growthAnalyticsEventSchema.safeParse({ name: "public_image_tool_observed" }).success,
		).toBe(false);
		expect(
			growthAnalyticsEventSchema.safeParse({ ...event(), name: "landing_viewed" }).success,
		).toBe(false);
		expect(
			growthAnalyticsEventSchema.safeParse(
				event({
					...observation,
					page: "/gta-loading-screen-generator",
					intent: "loading-art",
					sourceMode: "scene",
				}),
			).success,
		).toBe(false);
	});

	it("sends only public fields and keeps raw job identity inside the existing dispatcher options", async () => {
		await expect(
			trackGtaToolEvent("result_download_clicked", "wallpaper", defaultGtaSettings("wallpaper"), {
				jobKey: "private-job",
				dedupeKey: "download:private-job",
			}),
		).resolves.toBe("sent");
		expect(send.mock.calls[0]?.[0]).toEqual(
			event({ ...observation, stage: "result_download_clicked" }),
		);
		expect(JSON.stringify(send.mock.calls[0]?.[0])).not.toContain("private-job");
		expect(send.mock.calls[0]?.[1]).toEqual({
			taskKey: "private-job",
			dedupeKey: "download:private-job",
		});
	});

	it("rejects invalid choices and contains optional transport failures", async () => {
		await expect(
			trackGtaToolEvent("scene_selected", "wallpaper", {
				...defaultGtaSettings("wallpaper"),
				sceneId: "private-name",
			} as unknown as GtaSettings),
		).resolves.toBe("rejected");
		expect(send).not.toHaveBeenCalled();
		send.mockRejectedValueOnce(new Error("network unavailable"));
		await expect(
			trackGtaToolEvent("tool_view", "loading-art", defaultGtaSettings("loading-art")),
		).resolves.toBe("failed");
	});

	it("retains consent gating and hashes the job before dispatching the event payload", async () => {
		let consent = false;
		const dispatch = vi.fn();
		const hashTask = vi.fn().mockResolvedValue(`sha256:${"b".repeat(64)}`);
		const dispatcher = createBrowserGrowthAnalyticsDispatcher({
			getCookie: () => (consent ? "consent=true; consent_version=2" : "consent=false"),
			resolveAnonymousSessionHash: async () => `sha256:${"a".repeat(64)}`,
			dispatch,
			hashTask,
		});
		await expect(dispatcher.track(event(), { taskKey: "private-job" })).resolves.toBe("blocked");
		expect(hashTask).not.toHaveBeenCalled();
		expect(dispatch).not.toHaveBeenCalled();
		consent = true;
		await expect(dispatcher.track(event(), { taskKey: "private-job" })).resolves.toBe("sent");
		expect(hashTask).toHaveBeenCalledWith(`sha256:${"a".repeat(64)}`, "private-job");
		expect(dispatch.mock.calls[0]?.[1].properties.task_hash).toBe(`sha256:${"b".repeat(64)}`);
		expect(JSON.stringify(dispatch.mock.calls)).not.toContain("private-job");
	});

	it.each(Object.values(GTA_PAGES))(
		"keeps $path attribution while removing private query and hash state",
		({ path }) => {
			const url = new URL(
				`https://example.com${path}?job=private-job&name=private-name&utm_source=google#asset=private-photo`,
			);
			expect(sanitizeAttributionPath(url.href, url.origin)).toBe(path);
			expect(publicAnalyticsPath(url)).toBe(path);
			expect(growthAnalyticsPath(url)).toBe(path);
			expect(analyticsPageLocation(url)).toBe(`https://example.com${path}?utm_source=google`);
			const firstTouch = collectFirstTouchAttribution(url.href, "");
			expect(firstTouch.landingPath).toBe(path);
			expect(JSON.stringify(firstTouch)).not.toMatch(/private-job|private-name|private-photo/);
			expect(publicAnalyticsPath(new URL(`https://example.com${path}/neon-boulevard`))).toBeNull();
		},
	);
});
