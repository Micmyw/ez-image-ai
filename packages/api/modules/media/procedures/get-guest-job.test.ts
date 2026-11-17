import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const databaseMocks = vi.hoisted(() => ({
	getGuestJobSnapshot: vi.fn(),
	getRegisteredGuestJobSnapshot: vi.fn(),
}));

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database", () => databaseMocks);
vi.mock("@repo/database/client", () => ({ db: {} }));

import { auth } from "@repo/auth";

import { getGuestJob } from "./get-guest-job";

describe("getGuestJob", () => {
	it("returns only the public preset header from this owner's frozen prompt", async () => {
		const header =
			"Coastal artwork preset gta-coastal-v1. Task wallpaper. Scene beach-sunset. Input photo. Format phone. Portrait right.";
		databaseMocks.getGuestJobSnapshot.mockResolvedValue({
			jobId: "job-1",
			stage: "READY",
			projectedDispatchAt: new Date("2035-01-01T00:00:00Z"),
			estimateExpiresAt: new Date("2035-01-01T00:01:00Z"),
			resultExpiresAt: new Date("2035-01-02T00:00:00Z"),
			resultAssetId: "output",
			watermarked: true,
			trialConsumed: true,
			linkReady: true,
			inputPrompt: `${header}\n\nPrivate text and customer name and sourceAssetId`,
		});
		const result = await call(
			getGuestJob,
			{ jobId: "job-1" },
			{ context: { headers: new Headers() } },
		);
		expect(result.toolPrompt).toBe(header);
		expect(JSON.stringify(result)).not.toMatch(
			/Private text|customer name|sourceAssetId|inputPrompt/,
		);
	});
	it.each(["REJECTED", "REVIEW", "ERROR"])(
		"explains a guest output %s without exposing diagnostics",
		async (status) => {
			databaseMocks.getGuestJobSnapshot.mockResolvedValue({
				jobId: "job-1",
				stage: "FAILED",
				projectedDispatchAt: new Date("2026-09-16T00:00:00Z"),
				estimateExpiresAt: new Date("2026-09-16T00:01:00Z"),
				resultExpiresAt: new Date("2026-09-17T00:00:00Z"),
				resultAssetId: null,
				watermarked: false,
				trialConsumed: true,
				linkReady: true,
				outputSafety: {
					status,
					reasonCode: "SEEAPI_CONTENT_NOT_ALLOWED",
					rawEnvelope: { private: "detail" },
				},
			});
			const result = await call(
				getGuestJob,
				{ jobId: "job-1" },
				{ context: { headers: new Headers() } },
			);
			expect(result).toHaveProperty("safety", {
				outcome: status === "REJECTED" ? "blocked" : "unavailable",
				reason: status === "REJECTED" ? "restrictedContent" : null,
			});
			expect(JSON.stringify(result)).not.toMatch(/seeapi|rawEnvelope|private|reasonCode/i);
		},
	);
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "guest-1", isAnonymous: true },
			session: { id: "guest-session-1", userId: "guest-1" },
		} as never);
	});

	it("serializes only the opaque approved guest result asset id", async () => {
		databaseMocks.getGuestJobSnapshot.mockResolvedValue({
			jobId: "job-1",
			stage: "READY",
			projectedDispatchAt: new Date("2026-08-28T00:00:00.000Z"),
			estimateExpiresAt: new Date("2026-08-28T00:01:00.000Z"),
			resultExpiresAt: new Date("2026-08-29T00:00:00.000Z"),
			resultAssetId: "guest-output-1",
			watermarked: true,
			trialConsumed: true,
			linkReady: true,
		});

		const result = await call(
			getGuestJob,
			{ jobId: "job-1" },
			{ context: { headers: new Headers() } },
		);

		expect(result).toEqual({
			jobId: "job-1",
			stage: "READY",
			projectedDispatchAt: "2026-08-28T00:00:00.000Z",
			estimateExpiresAt: "2026-08-28T00:01:00.000Z",
			resultExpiresAt: "2026-08-29T00:00:00.000Z",
			resultAssetId: "guest-output-1",
			watermarked: true,
			trialConsumed: true,
			linkReady: true,
		});
		expect(JSON.stringify(result)).not.toMatch(/objectKey|signed|provider|model|cost/i);
	});
});
