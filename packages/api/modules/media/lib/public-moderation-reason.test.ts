import { describe, expect, it } from "vitest";

import { toMediaOrpcError } from "./errors";
import { publicImageModerationReason, TextModerationError } from "./public-moderation-reason";

describe("public moderation reason boundary", () => {
	it("explains an administrator content rejection without implying a detector outage", () => {
		expect(
			publicImageModerationReason({ status: "REJECTED", reasonCode: "ADMIN_CONTENT_REJECTED" }),
		).toBe("restrictedContent");
		expect(
			publicImageModerationReason({
				status: "BYPASSED",
				reasonCode: "MODERATION_TECHNICAL_FAILURE_BYPASS",
			}),
		).toBeNull();
	});
	it.each(["REVIEW", "ERROR", "APPROVED", "PENDING"])(
		"does not attach a violation reason to image status %s",
		(status) => {
			expect(publicImageModerationReason({ status, reasonCode: "SEXUAL_CONTENT" })).toBeNull();
		},
	);
	it("does not guess a category from undocumented SeeAPI labels", () => {
		expect(
			publicImageModerationReason({ status: "REJECTED", reasonCode: "SEEAPI_CONTENT_NOT_ALLOWED" }),
		).toBe("restrictedContent");
		expect(
			publicImageModerationReason({ status: "REJECTED", reasonCode: "TEST_DECISION" }),
		).toBeNull();
	});
	it.each(["REVIEW", "ERROR"] as const)(
		"keeps a %s prompt unclassified even with category evidence",
		(decision) => {
			const error = new TextModerationError({
				decision,
				reasonCode: "SEXUAL_CONTENT",
				ruleVersion: "private-rule",
				evidence: {
					requestId: "private-request",
					models: [],
					operations: 1,
					scores: { sexual: 1 },
					waffo: {
						requestId: "private-request",
						action: "review",
						semanticStatus: "scored",
						matchedCategories: ["adult_nsfw"],
					},
				},
			});
			expect(toMediaOrpcError(error).data).toEqual({
				code: decision === "REVIEW" ? "CONTENT_REVIEW_REQUIRED" : "SAFETY_CHECK_UNAVAILABLE",
			});
			expect(JSON.stringify(error)).not.toMatch(/private|scores|waffo/i);
		},
	);
	it("explains an unsupported prompt language separately from a service outage", () => {
		const error = new TextModerationError({
			decision: "REVIEW",
			reasonCode: "UNSUPPORTED_TEXT_LANGUAGE",
			ruleVersion: "private-rule",
		});
		expect(toMediaOrpcError(error).data).toEqual({ code: "TEXT_LANGUAGE_UNSUPPORTED" });
	});
	it("does not forward arbitrary error properties as trusted public diagnostics", () => {
		const error = Object.assign(new Error("CONTENT_NOT_ALLOWED"), {
			moderationReason: "sexualContent",
			data: { requestId: "private" },
		});
		expect(toMediaOrpcError(error).data).toEqual({ code: "CONTENT_NOT_ALLOWED" });
	});
});
