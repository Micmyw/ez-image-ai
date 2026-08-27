import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: vi.fn() } },
}));
vi.mock("../lib/guest-admission", () => ({
	submitGuestGenerationForGuest: vi.fn(),
}));

import { auth } from "@repo/auth";

import { submitGuestGenerationForGuest } from "../lib/guest-admission";
import { submitGuestGeneration } from "./submit-guest-generation";

describe("submitGuestGeneration", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "guest-1", isAnonymous: true },
			session: { id: "anonymous-session-1", userId: "guest-1" },
		} as never);
		vi.mocked(submitGuestGenerationForGuest).mockResolvedValue({
			jobId: "job-1",
			stage: "WAITING",
			projectedDispatchAt: new Date("2026-08-28T00:00:00.000Z"),
			estimateExpiresAt: new Date("2026-08-28T00:01:00.000Z"),
			resultExpiresAt: new Date("2026-08-29T00:00:00.000Z"),
			watermarked: false,
			trialConsumed: false,
			linkReady: true,
		});
	});

	it("returns only the safe guest job snapshot and never invokes immediate dispatch", async () => {
		const headers = new Headers({
			origin: "https://app.ezpic.test",
			"x-vercel-forwarded-for": "203.0.113.42",
		});
		const result = await call(submitGuestGeneration, validInput(), { context: { headers } });

		expect(result).toEqual({
			jobId: "job-1",
			stage: "WAITING",
			projectedDispatchAt: "2026-08-28T00:00:00.000Z",
			estimateExpiresAt: "2026-08-28T00:01:00.000Z",
			resultExpiresAt: "2026-08-29T00:00:00.000Z",
			watermarked: false,
			trialConsumed: false,
			linkReady: true,
		});
		expect(Object.keys(result)).toEqual([
			"jobId",
			"stage",
			"projectedDispatchAt",
			"estimateExpiresAt",
			"resultExpiresAt",
			"watermarked",
			"trialConsumed",
			"linkReady",
		]);
		expect(submitGuestGenerationForGuest).toHaveBeenCalledWith(
			expect.objectContaining({
				ownerId: "guest-1",
				sessionId: "anonymous-session-1",
				origin: "https://app.ezpic.test",
			}),
			validInput(),
			expect.anything(),
		);
	});

	it("rejects a registered session at the anonymous-only boundary", async () => {
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "registered-1", isAnonymous: false },
			session: { id: "registered-session-1", userId: "registered-1" },
		} as never);

		await expect(
			call(submitGuestGeneration, validInput(), { context: { headers: new Headers() } }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(submitGuestGenerationForGuest).not.toHaveBeenCalled();
	});
});

function validInput() {
	return {
		capabilityVersion: "guest-v7",
		sourceAssetId: "asset-1",
		prompt: "Make the sky violet",
		idempotencyKey: "guest-submit-0001",
		deviceId: "d4fbf8d2-945a-4f2c-8359-f179f6c734de",
		turnstileToken: "turnstile-token",
	};
}
