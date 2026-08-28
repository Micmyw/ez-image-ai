import { describe, expect, it } from "vitest";

import { evaluateGuestOperationalSafety } from "./admin-diagnostics";

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
