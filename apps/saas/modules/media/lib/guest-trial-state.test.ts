import { describe, expect, it } from "vitest";

import { resolveGuestTrialView, type GuestTrialSnapshot } from "./guest-trial-state";

const waitingSnapshot: GuestTrialSnapshot = {
	jobId: "guest-job-1",
	stage: "WAITING",
	projectedDispatchAt: "2026-08-28T00:00:30.000Z",
	estimateExpiresAt: "2026-08-28T00:01:00.000Z",
	resultExpiresAt: "2026-08-29T00:00:00.000Z",
	resultAssetId: null,
	watermarked: false,
	trialConsumed: false,
	linkReady: true,
};

describe("resolveGuestTrialView", () => {
	it("uses the delayed state after the server estimate expires without an exact countdown", () => {
		const view = resolveGuestTrialView(waitingSnapshot, new Date("2026-08-28T00:01:01.000Z"));

		expect(view).toMatchObject({ state: "delayed" });
		expect(JSON.stringify(view)).not.toMatch(/countdown|secondsRemaining|queuePosition|percent/i);
	});

	it("maps only server-owned stages and exposes the result only with an approved asset", () => {
		expect(
			resolveGuestTrialView(waitingSnapshot, new Date("2026-08-28T00:00:20.000Z")),
		).toMatchObject({ state: "waiting" });
		expect(
			resolveGuestTrialView(
				{ ...waitingSnapshot, stage: "EDITING" },
				new Date("2026-08-28T00:00:20.000Z"),
			),
		).toMatchObject({ state: "editing" });
		expect(
			resolveGuestTrialView(
				{ ...waitingSnapshot, stage: "FINISHING" },
				new Date("2026-08-28T00:00:20.000Z"),
			),
		).toMatchObject({ state: "finishing" });
		expect(
			resolveGuestTrialView(
				{
					...waitingSnapshot,
					stage: "READY",
					resultAssetId: "guest-output-1",
					watermarked: true,
					trialConsumed: true,
				},
				new Date("2026-08-28T00:00:20.000Z"),
			),
		).toMatchObject({ state: "ready", resultAssetId: "guest-output-1" });
		expect(
			resolveGuestTrialView(
				{ ...waitingSnapshot, stage: "READY", resultAssetId: null, watermarked: false },
				new Date("2026-08-28T00:00:20.000Z"),
			),
		).toMatchObject({ state: "moderatingOutput" });
	});

	it.each([
		["REJECTED", "rejected"],
		["FAILED", "failed"],
		["EXPIRED", "expired"],
	] as const)("maps %s to %s", (stage, state) => {
		expect(
			resolveGuestTrialView({ ...waitingSnapshot, stage }, new Date("2026-08-28T00:00:20.000Z")),
		).toMatchObject({ state });
	});
});
