import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database", () => ({
	acknowledgeModerationIncident: vi.fn(),
	applyAdminModerationReview: vi.fn(),
	completeAdminTextRecheck: vi.fn(),
	getAdminModerationOperations: vi.fn(),
	getAdminModerationReviewDetail: vi.fn(),
}));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/storage", () => ({ createSignedReadUrl: vi.fn() }));
vi.mock("../lib/text-moderation", () => ({
	createTextModerationAdapter: vi.fn(),
	moderateTextWithRetry: vi.fn(),
	TEXT_MODERATION_RULE_VERSION: "test",
}));

import { auth } from "@repo/auth";
import {
	applyAdminModerationReview,
	completeAdminTextRecheck,
	getAdminModerationOperations,
	getAdminModerationReviewDetail,
} from "@repo/database";
import { createSignedReadUrl } from "@repo/storage";

import { createTextModerationAdapter } from "../lib/text-moderation";
import {
	adminModerationAcknowledge,
	adminModerationDetail,
	adminModerationOperations,
	adminModerationReviewAction,
} from "./admin-moderation";

const context = { context: { headers: new Headers() } };
beforeEach(() => {
	vi.clearAllMocks();
});
function login(role: string) {
	vi.mocked(auth.api.getSession).mockResolvedValue({
		user: { id: "admin", role },
		session: { id: "session" },
	} as never);
}
const review = {
	id: "review-1",
	targetType: "ASSET",
	targetId: "asset-1",
	provider: "seeapi",
	stage: "IMAGE",
	status: "PENDING_REVIEW",
	bypassed: true,
	failureCount: 4,
	lastErrorCode: "MODERATION_TIMEOUT",
	firstFailureAt: new Date(),
	lastFailureAt: new Date(),
	updatedAt: new Date(),
	resolvedAt: null,
	resolutionReason: null,
	version: 0,
};

describe("moderation administrator boundary", () => {
	it("returns a failed adapter recheck to an actionable blocked state", async () => {
		login("admin");
		vi.mocked(applyAdminModerationReview).mockResolvedValue({
			reviewId: review.id,
			status: "RECHECKING",
			replayed: false,
		});
		vi.mocked(getAdminModerationReviewDetail).mockResolvedValue({
			review: { ...review, targetType: "QUOTE" },
			prompt: "A forest",
			asset: null,
		} as never);
		vi.mocked(createTextModerationAdapter).mockImplementation(() => {
			throw new Error("TEXT_MODERATION_CONFIGURATION_ERROR");
		});
		vi.mocked(completeAdminTextRecheck).mockResolvedValue({ stale: false, status: "BLOCKED" });
		const result = await call(
			adminModerationReviewAction,
			{
				reviewId: review.id,
				version: 0,
				action: "RECHECK",
				reason: "Recheck after detector recovery",
				idempotencyKey: "recheck-key-1",
			},
			context,
		);
		expect(result.status).toBe("BLOCKED");
		expect(completeAdminTextRecheck).toHaveBeenCalledWith(
			expect.objectContaining({
				moderation: expect.objectContaining({
					decision: "ERROR",
					retry: expect.objectContaining({ failures: 1 }),
				}),
			}),
			expect.anything(),
		);
	});
	it("denies every review route before reading data or generating private URLs", async () => {
		login("user");
		await expect(call(adminModerationOperations, { limit: 25 }, context)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(
			call(adminModerationDetail, { reviewId: "review-1" }, context),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			call(
				adminModerationAcknowledge,
				{ incidentId: "incident-1", reason: "Inspect this outage now" },
				context,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			call(
				adminModerationReviewAction,
				{
					reviewId: "review-1",
					version: 0,
					action: "APPROVE",
					reason: "Manually inspected image",
					idempotencyKey: "review-key-1",
				},
				context,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(getAdminModerationOperations).not.toHaveBeenCalled();
		expect(getAdminModerationReviewDetail).not.toHaveBeenCalled();
		expect(applyAdminModerationReview).not.toHaveBeenCalled();
		expect(createSignedReadUrl).not.toHaveBeenCalled();
	});
	it("strips private content and raw payloads from list responses", async () => {
		login("admin");
		vi.mocked(getAdminModerationOperations).mockResolvedValue({
			pendingCount: 1,
			openCount: 1,
			nextCursor: null,
			incidents: [],
			reviews: [
				{
					...review,
					jobIds: ["job-1"],
					prompt: "private prompt",
					rawEnvelope: { secret: "secret" },
				},
			],
		} as never);
		const result = await call(adminModerationOperations, { limit: 25 }, context);
		expect(result.reviews).toHaveLength(1);
		expect(JSON.stringify(result)).not.toMatch(/private prompt|secret|rawEnvelope/);
	});
	it("issues a short-lived preview only on explicit administrator inspection", async () => {
		login("admin");
		vi.mocked(getAdminModerationReviewDetail).mockResolvedValue({
			review,
			prompt: null,
			asset: {
				objectKey: "private/object.png",
				mimeType: "image/png",
				verificationSubmissionUncertain: false,
			},
		} as never);
		vi.mocked(createSignedReadUrl).mockResolvedValue("https://private.example/temporary");
		const result = await call(adminModerationDetail, { reviewId: "review-1" }, context);
		expect(createSignedReadUrl).toHaveBeenCalledWith({
			bucket: "media",
			key: "private/object.png",
			expiresIn: 60,
		});
		expect(JSON.stringify(result)).not.toContain("private/object.png");
	});
	it("requires an audit reason and passes the authenticated administrator identity", async () => {
		login("admin");
		await expect(
			call(
				adminModerationReviewAction,
				{
					reviewId: "review-1",
					version: 0,
					action: "REJECT",
					reason: "x",
					idempotencyKey: "review-key-1",
				},
				context,
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		vi.mocked(applyAdminModerationReview).mockResolvedValue({
			reviewId: "review-1",
			status: "REJECTED",
			replayed: false,
		});
		await call(
			adminModerationReviewAction,
			{
				reviewId: "review-1",
				version: 0,
				action: "REJECT",
				reason: "Manually inspected image",
				idempotencyKey: "review-key-1",
			},
			context,
		);
		expect(applyAdminModerationReview).toHaveBeenCalledWith(
			expect.objectContaining({ actorUserId: "admin", version: 0 }),
			expect.anything(),
		);
	});
});
