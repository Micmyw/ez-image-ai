import { describe, expect, it } from "vitest";

import { videoTemplateDiagnosticsTimings } from "./template-telemetry";

describe("template segmented timing evidence", () => {
	it("keeps unavailable or inverted observations null rather than claiming zero waiting", () => {
		const report = videoTemplateDiagnosticsTimings(
			{ readyAt: "not-a-date", providerSubmitStartedAt: "2026-10-05T00:00:01Z" },
			{ resolvedAt: "2026-10-05T00:00:02Z", stageData: { prompt: "private", url: "private" } },
		);
		expect(report.durations.sceneToVideoSchedulingMs).toBeNull();
		expect(report.durations.totalMs).toBeNull();
		expect(report.timings.readyAt).toBeNull();
		expect(JSON.stringify(report)).not.toContain("private");
	});
	it("separates provider wait, transfer and the direct scene-to-video handoff", () => {
		const report = videoTemplateDiagnosticsTimings(
			{ providerSubmitStartedAt: new Date("2026-10-05T00:00:10.250Z") },
			{
				submittedAt: new Date("2026-10-05T00:00:01Z"),
				acceptedAt: new Date("2026-10-05T00:00:02Z"),
				completedAt: new Date("2026-10-05T00:00:08Z"),
				resolvedAt: new Date("2026-10-05T00:00:10Z"),
				stageData: { sceneStoredAt: "2026-10-05T00:00:09Z" },
			},
		);
		expect(report.durations.sceneRequestMs).toBe(1000);
		expect(report.durations.sceneProviderWaitMs).toBe(6000);
		expect(report.durations.sceneTransferMs).toBe(1000);
		expect(report.durations.sceneToVideoSchedulingMs).toBe(250);
	});
});
