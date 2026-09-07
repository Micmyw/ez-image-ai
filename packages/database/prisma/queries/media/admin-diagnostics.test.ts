import { describe, expect, it, vi } from "vitest";

import {
	evaluateGuestOperationalSafety,
	listAdminUncertainGenerationAttempts,
} from "./admin-diagnostics";

const safeMetrics = {
	heldRiskMicros: 0n,
	committedRiskMicros: 0n,
	riskBudgetMicros: 100_000n,
	queueDepth: 0,
	oldestQueueAgeSeconds: 0,
	uncertainOlderThanTenMinutes: 0,
	moderationErrorRate: 0,
	watermarkFailures: 0,
	billedSpendMismatch: 0,
	overdueCleanupAssets: 0,
};

describe("guest operational safety thresholds", () => {
	it.each([
		[50_000n, "WARN", "WARN"],
		[75_000n, "SLOW", "SLOW"],
		[90_000n, "CLOSED", "CLOSE"],
		[100_000n, "EXHAUSTED", "REJECT"],
	] as const)("applies the exact risk threshold at %s micros", (committed, state, action) => {
		expect(
			evaluateGuestOperationalSafety({ ...safeMetrics, committedRiskMicros: committed }),
		).toMatchObject({ riskState: state, admissionAction: action });
	});

	it("warns after queue depth 20 or five minutes and closes at 25 or ten minutes", () => {
		expect(evaluateGuestOperationalSafety({ ...safeMetrics, queueDepth: 20 })).toMatchObject({
			admissionAction: "OPEN",
		});
		expect(evaluateGuestOperationalSafety({ ...safeMetrics, queueDepth: 21 })).toMatchObject({
			admissionAction: "WARN",
			warnings: ["QUEUE_DEPTH"],
		});
		expect(
			evaluateGuestOperationalSafety({ ...safeMetrics, oldestQueueAgeSeconds: 301 }),
		).toMatchObject({ admissionAction: "WARN", warnings: ["QUEUE_AGE"] });
		expect(evaluateGuestOperationalSafety({ ...safeMetrics, queueDepth: 25 })).toMatchObject({
			admissionAction: "CLOSE",
			closureReasons: ["QUEUE_DEPTH"],
		});
		expect(
			evaluateGuestOperationalSafety({ ...safeMetrics, oldestQueueAgeSeconds: 600 }),
		).toMatchObject({ admissionAction: "CLOSE", closureReasons: ["QUEUE_AGE"] });
	});

	it.each([
		["MODERATION_ERRORS", { moderationErrorRate: 0.0101 }],
		["WATERMARK_FAILURE", { watermarkFailures: 1 }],
		["BILLED_SPEND_MISMATCH", { billedSpendMismatch: 1 }],
		["CLEANUP_OVERDUE", { overdueCleanupAssets: 1 }],
	] as const)("closes only the guest admission override for %s", (reason, override) => {
		expect(evaluateGuestOperationalSafety({ ...safeMetrics, ...override })).toMatchObject({
			admissionAction: "CLOSE",
			closureReasons: [reason],
			automaticOverride: {
				configKey: "media.guestGeneration.enabled",
				value: false,
			},
		});
	});

	it("warns immediately for an uncertain guest Attempt older than ten minutes", () => {
		expect(
			evaluateGuestOperationalSafety({
				...safeMetrics,
				uncertainOlderThanTenMinutes: 1,
			}),
		).toMatchObject({ admissionAction: "WARN", warnings: ["UNCERTAIN_ATTEMPT_AGE"] });
	});

	it("fails closed when the guest risk budget is missing or invalid", () => {
		expect(evaluateGuestOperationalSafety({ ...safeMetrics, riskBudgetMicros: 0n })).toMatchObject({
			riskState: "EXHAUSTED",
			admissionAction: "REJECT",
			closureReasons: ["RISK_BUDGET_CONFIGURATION"],
			automaticOverride: {
				configKey: "media.guestGeneration.enabled",
				value: false,
			},
		});
	});
});

describe("uncertain generation attempt diagnostics", () => {
	it("returns only a current matrix-validated product selection", async () => {
		const productDefinitions = [
			{
				productKey: "image-gpt-image-2" as const,
				publicName: "GPT Image 2",
				skuCells: [
					{
						skuKey: "gpt-image-2-1k" as const,
						aspectRatios: ["auto", "1:1"] as const,
					},
					{
						skuKey: "gpt-image-2-4k" as const,
						aspectRatios: ["5:4"] as const,
					},
				],
			},
		];
		const timestamp = new Date("2026-09-07T00:00:00.000Z");
		const findMany = vi.fn().mockResolvedValue([
			{
				id: "attempt-gpt-1k-valid",
				status: "NEEDS_RECONCILIATION",
				reconciliationCount: 1,
				createdAt: timestamp,
				updatedAt: timestamp,
				submittedAt: null,
				completedAt: null,
				lastProviderEventAt: null,
				nextReconcileAt: null,
				job: {
					id: "job-gpt-1k-valid",
					productKey: "image-gpt-image-2",
					inputSnapshot: { skuKey: "gpt-image-2-1k", aspectRatio: "auto" },
					status: "NEEDS_RECONCILIATION",
					failureCode: "SUBMISSION_UNCERTAIN_NEEDS_RECONCILIATION",
					reservation: { id: "reservation-gpt-1k-valid", status: "ACTIVE" },
				},
			},
			{
				id: "attempt-valid",
				status: "NEEDS_RECONCILIATION",
				reconciliationCount: 2,
				createdAt: timestamp,
				updatedAt: timestamp,
				submittedAt: null,
				completedAt: null,
				lastProviderEventAt: null,
				nextReconcileAt: null,
				job: {
					id: "job-valid",
					productKey: "image-gpt-image-2",
					inputSnapshot: { skuKey: "gpt-image-2-4k", aspectRatio: "5:4" },
					status: "NEEDS_RECONCILIATION",
					failureCode: "SUBMISSION_UNCERTAIN_NEEDS_RECONCILIATION",
					reservation: { id: "reservation-valid", status: "ACTIVE" },
				},
			},
			{
				id: "attempt-invalid",
				status: "NEEDS_RECONCILIATION",
				reconciliationCount: 0,
				createdAt: timestamp,
				updatedAt: timestamp,
				submittedAt: null,
				completedAt: null,
				lastProviderEventAt: null,
				nextReconcileAt: null,
				job: {
					id: "job-invalid",
					productKey: "image-gpt-image-2",
					inputSnapshot: { skuKey: "gpt-image-2-4k", aspectRatio: "1:1" },
					status: "NEEDS_RECONCILIATION",
					failureCode: "SUBMISSION_UNCERTAIN_NEEDS_RECONCILIATION",
					reservation: null,
				},
			},
		]);

		const result = await listAdminUncertainGenerationAttempts(
			{ limit: 20 },
			{
				generationAttempt: { findMany },
			} as never,
			productDefinitions,
		);

		expect(result.map((item) => item.selection)).toEqual([
			{
				productKey: "image-gpt-image-2",
				skuKey: "gpt-image-2-1k",
				aspectRatio: "auto",
			},
			{
				productKey: "image-gpt-image-2",
				skuKey: "gpt-image-2-4k",
				aspectRatio: "5:4",
			},
			null,
		]);
		const query = findMany.mock.calls[0]?.[0];
		expect(query.select).not.toHaveProperty("provider");
		expect(query.select).not.toHaveProperty("providerModelId");
		expect(query.select).not.toHaveProperty("providerTaskId");
		expect(query.select).not.toHaveProperty("providerCostMicros");
		expect(query.select.job.select).toMatchObject({ productKey: true, inputSnapshot: true });
		expect(JSON.stringify(result)).not.toMatch(
			/"route":|"provider":|providerModelId|providerTaskId|providerCostMicros|costMicros|marginMicros/i,
		);
	});
});
