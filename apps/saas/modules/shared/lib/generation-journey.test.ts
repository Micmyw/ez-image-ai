import { afterEach, describe, expect, it, vi } from "vitest";

const send = vi.hoisted(() => vi.fn().mockResolvedValue("sent"));
const revision = vi.hoisted(() => ({ value: 0 }));
vi.mock("@repo/utils/lib/growth-analytics-browser", () => ({
	trackBrowserGrowthEvent: send,
	growthConsentRevision: () => revision.value,
}));
import {
	createJourneyReference,
	rememberJourneyJob,
	trackGenerationJourney,
	trackJourneyResultVisible,
} from "./generation-journey";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	revision.value++;
	send.mockClear();
});
const doc = (visibilityState = "visible", consent = true) => ({
	visibilityState,
	cookie: consent ? "consent=true; consent_version=2" : "consent=false",
	prerendering: false,
});
describe("optional journey observations", () => {
	it("uses the original click clock and leaves missing or revoked timing unknown", async () => {
		vi.stubGlobal("document", doc());
		const now = vi.spyOn(performance, "now").mockReturnValue(100);
		rememberJourneyJob({ jobKey: "timed-job", startedAt: 50 });
		now.mockReturnValue(200);
		rememberJourneyJob({ jobKey: "timed-job", startedAt: 190 });
		await trackJourneyResultVisible("timed-job");
		expect(send.mock.lastCall?.[0]).toMatchObject({
			properties: { journey: { elapsedMs: 150, latencyBoundary: "generate_to_visible" } },
		});
		await trackJourneyResultVisible("missing-clock");
		expect(send.mock.lastCall?.[0].properties.journey).not.toHaveProperty("elapsedMs");
		revision.value++;
		await trackJourneyResultVisible("timed-job");
		expect(send.mock.lastCall?.[0].properties.journey).not.toHaveProperty("elapsedMs");
	});
	it("does not observe hidden auth pages or prerendered content", async () => {
		vi.stubGlobal("document", doc("hidden"));
		expect(await trackGenerationJourney({ stage: "auth_viewed" })).toBe("blocked");
		vi.stubGlobal("document", { ...doc(), prerendering: true });
		expect(await trackGenerationJourney({ stage: "result_visible" })).toBe("blocked");
		expect(send).not.toHaveBeenCalled();
	});
	it("does not create diagnostic identity without consent and rejects private fields", async () => {
		vi.stubGlobal("document", doc("visible", false));
		expect(createJourneyReference()).toBeUndefined();
		expect(await trackGenerationJourney({ stage: "generate_clicked" })).toBe("blocked");
		vi.stubGlobal("document", doc());
		expect(
			await trackGenerationJourney({ stage: "generate_clicked", prompt: "private" } as Parameters<
				typeof trackGenerationJourney
			>[0]),
		).toBe("rejected");
		expect(send).not.toHaveBeenCalled();
	});
	it("keeps raw job keys out of event properties and contains dispatch failures", async () => {
		vi.stubGlobal("document", doc());
		expect(
			await trackGenerationJourney(
				{ stage: "result_visible", elapsedMs: 1200, latencyBoundary: "generate_to_visible" },
				{ jobKey: "private-job" },
			),
		).toBe("sent");
		expect(send.mock.calls[0]![0]).toEqual({
			name: "generation_journey_observed_v1",
			properties: {
				journey: {
					version: 1,
					stage: "result_visible",
					elapsedMs: 1200,
					latencyBoundary: "generate_to_visible",
				},
			},
		});
		send.mockRejectedValueOnce(new Error("blocked analytics"));
		expect(await trackGenerationJourney({ stage: "generate_clicked" })).toBe("failed");
	});
});
