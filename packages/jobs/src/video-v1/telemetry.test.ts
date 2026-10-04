import { describe, expect, it, vi } from "vitest";

import { recordVideoStageMetric, videoDurationMs } from "./telemetry";

describe("video telemetry", () => {
	it("keeps absent, invalid and clock-inverted timings unknown", () => {
		expect(videoDurationMs(null, new Date().toISOString())).toBeNull();
		expect(videoDurationMs("invalid", "invalid")).toBeNull();
		expect(videoDurationMs("2026-01-01T00:00:01Z", "2026-01-01T00:00:00Z")).toBeNull();
		expect(videoDurationMs("2026-01-01T00:00:00Z", "2026-01-01T00:00:01Z")).toBe(1000);
	});
	it("does not emit arbitrary raw error bodies", () => {
		const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
		try {
			recordVideoStageMetric({
				jobId: "j",
				stage: "storage",
				durationMs: 5,
				errorCode: "https://private/token=secret",
			});
			expect(log).toHaveBeenCalledWith("video-v1.stage", {
				jobId: "j",
				stage: "storage",
				durationMs: 5,
				errorCode: "VIDEO_STAGE_ERROR",
			});
		} finally {
			log.mockRestore();
		}
	});
});
