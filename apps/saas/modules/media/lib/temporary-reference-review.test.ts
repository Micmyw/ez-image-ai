import { describe, expect, it } from "vitest";

import {
	temporaryReferenceReviewPollingInterval,
	temporaryReferenceReviewPresentation,
	type TemporaryReferenceReview,
} from "./temporary-reference-review";

describe("temporary reference pre-review presentation", () => {
	it.each(["PENDING", "APPROVED", "NOT_STARTED"] as const)(
		"allows %s to use the existing Generate admission and review",
		(status) => {
			expect(
				temporaryReferenceReviewPresentation({ status, moderationReason: null }, null),
			).toMatchObject({ canSubmit: true, safetyMessage: null });
		},
	);
	it("keeps upload-only and a transient status-read failure usable without calling either an approval", () => {
		expect(
			temporaryReferenceReviewPresentation({ status: "NOT_STARTED", moderationReason: null }, null)
				.status,
		).toBe("uploadedForGeneration");
		expect(
			temporaryReferenceReviewPresentation(undefined, new Error("network timeout")),
		).toMatchObject({ canSubmit: true, safetyMessage: null, status: "reviewStatusUnavailable" });
	});
	it("blocks a rejected image with a public reason and distinguishes exhausted technical review", () => {
		expect(
			temporaryReferenceReviewPresentation(
				{ status: "REJECTED", moderationReason: "sexualContent" },
				null,
			),
		).toMatchObject({
			canSubmit: false,
			safetyMessage: "blocked",
			moderationReason: "sexualContent",
		});
		expect(
			temporaryReferenceReviewPresentation({ status: "UNAVAILABLE", moderationReason: null }, null),
		).toMatchObject({
			canSubmit: false,
			safetyMessage: "safetyUnavailable",
			moderationReason: null,
		});
	});
	it("does not revive cached approval after the owner/token/expiry read is denied", () => {
		expect(
			temporaryReferenceReviewPresentation(
				{ status: "APPROVED", moderationReason: null },
				{ code: "NOT_FOUND" },
			),
		).toMatchObject({ canSubmit: false, safetyMessage: "safetyUnavailable" });
	});
	it("does not erase a known rejection after a transient network error", () => {
		expect(
			temporaryReferenceReviewPresentation(
				{ status: "REJECTED", moderationReason: "restrictedContent" },
				new Error("network timeout"),
			).canSubmit,
		).toBe(false);
	});
	it.each(["APPROVED", "REJECTED", "UNAVAILABLE", "NOT_STARTED"] as const)(
		"stops the pre-review poll at %s",
		(status) => {
			expect(
				temporaryReferenceReviewPollingInterval({
					enabled: true,
					data: { status, moderationReason: null },
				}),
			).toBe(false);
		},
	);
	it("polls only active, pending references and retries transient reads without creating a new review", () => {
		const data: TemporaryReferenceReview = { status: "PENDING", moderationReason: null };
		expect(temporaryReferenceReviewPollingInterval({ enabled: true, data })).toBe(1000);
		expect(
			temporaryReferenceReviewPollingInterval({ enabled: true, error: new Error("network") }),
		).toBe(1000);
		expect(temporaryReferenceReviewPollingInterval({ enabled: false, data })).toBe(false);
		expect(
			temporaryReferenceReviewPollingInterval({
				enabled: true,
				data,
				error: { code: "NOT_FOUND" },
			}),
		).toBe(false);
	});
});
