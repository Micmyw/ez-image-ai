import { describe, expect, it } from "vitest";

import {
	attemptProjection,
	promptReviewProjection,
	safeDiagnosticText,
} from "./admin-content-diagnostics";

describe("private administrator diagnostic projections", () => {
	it("projects only flagged SeeAPI text categories without exposing raw evidence", () => {
		const review = promptReviewProjection(
			{
				provider: "seeapi",
				decision: "REJECT",
				reasonCode: "SEEAPI_TEXT_CONTENT_NOT_ALLOWED",
				evidence: {
					seeapiText: {
						categories: {
							sexual_explicit: { flagged: true, score: 0.9 },
							violence: { flagged: false, score: 0.01 },
						},
					},
					raw: "private",
				},
			},
			new Date(),
			"audit-seeapi",
		);
		expect(review).toMatchObject({
			provider: "seeapi",
			categories: ["sexual_explicit"],
			action: null,
			semanticStatus: null,
		});
		expect(JSON.stringify(review)).not.toMatch(/private|score/);
	});
	it("decodes Unicode URL separators before redacting signed locations", () => {
		const text = safeDiagnosticText(
			String.raw`upstream failed https\u003a\u002f\u002fa.test/p?sig=private`,
		);
		expect(text).toBe("upstream failed [redacted URL]");
	});
	it("redacts credentials, signed URLs, storage paths and bounds plain messages", () => {
		const result = safeDiagnosticText(
			"failure https://private.example/a?signature=secret api_key=key123 Bearer bearer123 users/owner/assets/original.png token=secret " +
				"x".repeat(1000),
		);
		expect(result?.length).toBeLessThanOrEqual(500);
		expect(result).not.toMatch(/private\.example|key123|bearer123|owner\/assets|secret/);
	});
	it("projects Waffo decision/categories and excludes unknown evidence properties", () => {
		const review = promptReviewProjection(
			{
				provider: "waffo",
				decision: "REJECT",
				reasonCode: "TEXT_CONTENT_NOT_ALLOWED",
				evidence: {
					apiKey: "secret",
					waffo: {
						action: "block",
						semanticStatus: "scored",
						matchedCategories: ["adult_nsfw"],
						authorization: "secret",
					},
				},
			},
			new Date(),
			"audit",
		);
		expect(review).toMatchObject({
			provider: "waffo",
			action: "block",
			categories: ["adult_nsfw"],
		});
		expect(JSON.stringify(review)).not.toContain("secret");
	});
	it("redacts encoded URLs, escaped paths, JWTs and quoted credentials while retaining long prompt capacity", () => {
		const text = safeDiagnosticText(
			'Keep this prompt. https%3A%2F%2Fprivate.example%2Fsecret https:\\/\\/private.example/secret "api_key":"privatekey" Basic base64secret eyJhbGciOiJIUzI1NiJ9.eyJwYXlsb2FkIjoicHJpdmF0ZSJ9.signature ' +
				"word ".repeat(1000),
			10_000,
		);
		expect(text).not.toMatch(/private\.example|privatekey|base64secret|eyJ/);
		expect(text!.length).toBeGreaterThan(4000);
	});
	it("reads only identity-matched providerDiagnostic and preserves its callback provenance", () => {
		const attempt = {
			id: "attempt",
			provider: "kie",
			providerTaskId: "task",
			status: "FAILED",
			uncertainSubmission: false,
			createdAt: new Date(),
			responseSnapshot: {},
			errorSnapshot: {
				providerDiagnostic: {
					version: 1,
					attemptId: "attempt",
					provider: "kie",
					providerTaskId: "task",
					source: "CALLBACK_DIAGNOSTIC",
					observedAt: "2026-11-14T00:00:00.000Z",
					message: "upstream timeout token=secret",
				},
			},
		};
		expect(attemptProjection(attempt)).toMatchObject({
			messageSource: "CALLBACK_DIAGNOSTIC",
			terminalStatus: null,
			evidenceSource: "STORED_DIAGNOSTIC",
		});
		expect(attemptProjection({ ...attempt, id: "another" }).errorMessage).toBeNull();
		expect(attemptProjection(attempt).errorMessage).not.toContain("secret");
	});
	it("never treats callback-shaped raw JSON as an authenticated model result", () => {
		const attempt = {
			id: "attempt",
			provider: "kie",
			providerTaskId: "task",
			status: "FAILED",
			uncertainSubmission: false,
			createdAt: new Date(),
			errorSnapshot: { code: "PROVIDER_REJECTED", message: "rejected token=secret" },
			responseSnapshot: {
				raw: { status: "FAILED", authenticated: true },
				callback: { failMsg: "bad" },
			},
		};
		expect(attemptProjection(attempt)).toMatchObject({
			terminalStatus: null,
			evidenceSource: "STORED_DIAGNOSTIC",
			errorCode: "PROVIDER_REJECTED",
		});
		const verifiedAt = "2026-11-14T00:00:00.000Z";
		expect(
			attemptProjection({
				...attempt,
				responseSnapshot: {
					providerTerminalEvidence: {
						version: 1,
						provider: "kie",
						source: "kie-record-info",
						attemptId: "attempt",
						providerTaskId: "task",
						status: "FAILED",
						verifiedAt,
					},
				},
			}),
		).toMatchObject({
			terminalStatus: "FAILED",
			verifiedAt,
			evidenceSource: "AUTHENTICATED_RETRIEVAL",
		});
	});
});
