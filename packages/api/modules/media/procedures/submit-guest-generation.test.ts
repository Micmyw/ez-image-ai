import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: vi.fn() } },
}));
vi.mock("../lib/guest-admission", () => ({
	submitGuestGenerationForGuest: vi.fn(),
}));
vi.mock("@repo/jobs/orchestration/client", () => ({ dispatchJob: vi.fn().mockResolvedValue({}) }));

import { auth } from "@repo/auth";
import { dispatchJob } from "@repo/jobs/orchestration/client";

import { submitGuestGenerationForGuest } from "../lib/guest-admission";
import { TextModerationError } from "../lib/public-moderation-reason";
import { submitGuestGeneration } from "./submit-guest-generation";

describe("submitGuestGeneration", () => {
	it("retains the accepted public header when an uncertain retry already completed", async () => {
		const header =
			"Coastal artwork preset gta-coastal-v1. Task loading-art. Scene marina. Input photo. Format desktop. Portrait left.";
		vi.mocked(submitGuestGenerationForGuest).mockResolvedValueOnce({
			trialId: "trial-1",
			jobId: "job-1",
			stage: "READY",
			projectedDispatchAt: new Date("2035-01-01T00:00:00Z"),
			estimateExpiresAt: new Date("2035-01-01T00:01:00Z"),
			resultExpiresAt: new Date("2035-01-02T00:00:00Z"),
			resultAssetId: "output",
			watermarked: true,
			trialConsumed: true,
			linkReady: true,
			inputPrompt: `${header}\n\nCustomer name and private supplemental prompt`,
		});
		const result = await call(submitGuestGeneration, validInput(), {
			context: { headers: new Headers() },
		});
		expect(result.toolPrompt).toBe(header);
		expect(JSON.stringify(result)).not.toMatch(/Customer name|private supplemental|inputPrompt/);
	});
	it("keeps an admitted response when optional defer registration throws", async () => {
		const result = await call(
			submitGuestGeneration,
			{ ...validInput(), journey: { actionRef: "malformed" } } as never,
			{
				context: {
					headers: new Headers(),
					defer: () => {
						throw new Error("DEFER_UNAVAILABLE");
					},
				},
			},
		);
		expect(result.jobId).toBe("job-1");
		expect(submitGuestGenerationForGuest).toHaveBeenCalledOnce();
		expect(vi.mocked(submitGuestGenerationForGuest).mock.calls[0]![1]).not.toHaveProperty(
			"journey",
		);
	});
	it.each(["REJECT", "REVIEW", "ERROR"] as const)(
		"returns a safe %s prompt outcome to guests",
		async (decision) => {
			vi.mocked(submitGuestGenerationForGuest).mockRejectedValue(
				new TextModerationError({
					decision,
					reasonCode: "SEXUAL_CONTENT",
					ruleVersion: "private-rule",
				}),
			);
			await expect(
				call(submitGuestGeneration, validInput(), { context: { headers: new Headers() } }),
			).rejects.toMatchObject({
				message:
					decision === "REJECT"
						? "CONTENT_NOT_ALLOWED"
						: decision === "REVIEW"
							? "CONTENT_REVIEW_REQUIRED"
							: "SAFETY_CHECK_UNAVAILABLE",
				data:
					decision === "REJECT"
						? { code: "CONTENT_NOT_ALLOWED", moderationReason: "sexualContent" }
						: {
								code:
									decision === "REVIEW" ? "CONTENT_REVIEW_REQUIRED" : "SAFETY_CHECK_UNAVAILABLE",
							},
			});
		},
	);
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "guest-1", isAnonymous: true },
			session: { id: "anonymous-session-1", userId: "guest-1" },
		} as never);
		vi.mocked(submitGuestGenerationForGuest).mockResolvedValue({
			trialId: "trial-1",
			jobId: "job-1",
			stage: "WAITING",
			projectedDispatchAt: new Date("2026-08-28T00:00:00.000Z"),
			estimateExpiresAt: new Date("2026-08-28T00:01:00.000Z"),
			resultExpiresAt: new Date("2026-08-29T00:00:00.000Z"),
			resultAssetId: null,
			watermarked: false,
			trialConsumed: false,
			linkReady: true,
		});
	});

	it("wakes the committed guest trial immediately while returning only the safe snapshot", async () => {
		const headers = new Headers({
			origin: "https://app.ezpic.test",
			"x-vercel-forwarded-for": "203.0.113.42",
		});
		const result = await call(submitGuestGeneration, validInput(), { context: { headers } });
		expect(dispatchJob).toHaveBeenCalledWith(
			"media-admit-guest-generation",
			{ jobId: "job-1", trialId: "trial-1" },
			expect.objectContaining({ idempotencyKey: "guest-admission:trial-1", timeoutMs: 1000 }),
		);

		expect(result).toEqual({
			jobId: "job-1",
			stage: "WAITING",
			projectedDispatchAt: "2026-08-28T00:00:00.000Z",
			estimateExpiresAt: "2026-08-28T00:01:00.000Z",
			resultExpiresAt: "2026-08-29T00:00:00.000Z",
			resultAssetId: null,
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
			"resultAssetId",
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

	it("does not dispatch when the guest admission transaction fails", async () => {
		vi.mocked(submitGuestGenerationForGuest).mockRejectedValueOnce(new Error("ADMISSION_FAILED"));
		await expect(
			call(submitGuestGeneration, validInput(), { context: { headers: new Headers() } }),
		).rejects.toThrow("ADMISSION_FAILED");
		expect(dispatchJob).not.toHaveBeenCalled();
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

	it.each(["image-fast", "image-gpt-image-2-5-sunburst"])(
		"rejects %s before entering sponsored guest admission",
		async (productKey) => {
			await expect(
				call(submitGuestGeneration, { ...validInput(), productKey } as never, {
					context: { headers: new Headers() },
				}),
			).rejects.toBeDefined();
			expect(submitGuestGenerationForGuest).not.toHaveBeenCalled();
		},
	);

	it("rejects any SKU except the fixed Nano Banana 2 Lite 1K offer", async () => {
		await expect(
			call(submitGuestGeneration, { ...validInput(), skuKey: "gpt-image-2-2k" } as never, {
				context: { headers: new Headers() },
			}),
		).rejects.toBeDefined();
		expect(submitGuestGenerationForGuest).not.toHaveBeenCalled();
	});
});

function validInput() {
	return {
		capabilityVersion: "guest-v7",
		productKey: "image-nano-banana-2-lite" as const,
		skuKey: "nano-banana-2-lite-1k" as const,
		sourceAssetId: "asset-1",
		prompt: "Make the sky violet",
		aspectRatio: "16:9" as const,
		idempotencyKey: "guest-submit-0001",
		deviceId: "d4fbf8d2-945a-4f2c-8359-f179f6c734de",
		turnstileToken: "turnstile-token",
	};
}
