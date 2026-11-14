import type { NormalizedResult, ProviderTaskSnapshot } from "@repo/ai";
import { describe, expect, it } from "vitest";

import {
	callbackFailureDiagnostic,
	retrievedFailureDiagnostic,
	submissionFailureDiagnostic,
	withProviderDiagnostic,
} from "./provider-diagnostics";

const attempt = { id: "attempt-1", provider: "kie", providerTaskId: "task-1" };
const observedAt = "2026-11-14T04:00:00.000Z";
const snapshot: ProviderTaskSnapshot = {
	providerTaskId: "task-1",
	status: "FAILED",
	raw: {},
	retrieval: { source: "kie-record-info", observedAt },
};
const result: NormalizedResult = {
	outputs: [],
	progress: null,
	providerCharged: false,
	providerCostMicros: null,
	retryable: false,
	failure: {
		code: "PROVIDER_REJECTED",
		message: 'Rendering failed {"api_key":"opaque-secret"}',
		retryable: false,
	},
};

describe("provider failure diagnostic provenance", () => {
	it("keeps authenticated retrieval separate from raw callback origin labels", () => {
		expect(retrievedFailureDiagnostic(attempt, snapshot, result)).toMatchObject({
			source: "AUTHENTICATED_RETRIEVAL",
			observedAt,
		});
		const callback = callbackFailureDiagnostic(attempt, snapshot, result, new Date(observedAt));
		expect(callback).toMatchObject({ source: "CALLBACK_DIAGNOSTIC", observedAt });
		expect(callback?.message).not.toContain("opaque-secret");
		expect(result.failure?.retryable).toBe(false);
	});
	it.each([
		{ ...snapshot, retrieval: undefined },
		{ ...snapshot, retrieval: { source: "replicate-prediction" as const, observedAt } },
	])("never infers authenticated origin from unmarked or mismatched retrieval %j", (untrusted) => {
		expect(
			retrievedFailureDiagnostic(
				attempt,
				{ ...untrusted, raw: { retrieval: snapshot.retrieval } },
				result,
			)?.source,
		).toBe("INTERNAL_DIAGNOSTIC");
	});
	it.each([
		{ ...snapshot, providerTaskId: "other-task" },
		{ ...snapshot, status: "RUNNING" as const },
		{ ...snapshot, status: "SUCCEEDED" as const },
	])("does not attach failure text to a mismatched task or nonfailure status", (invalid) => {
		expect(retrievedFailureDiagnostic(attempt, invalid, result)).toBeNull();
		expect(callbackFailureDiagnostic(attempt, invalid, result, new Date(observedAt))).toBeNull();
	});
	it("does not infer submission provenance from failure text", () => {
		const unbound = { ...attempt, providerTaskId: null };
		expect(submissionFailureDiagnostic(unbound, result.failure!)?.source).toBe(
			"INTERNAL_DIAGNOSTIC",
		);
		expect(
			submissionFailureDiagnostic(unbound, {
				...result.failure!,
				messageOrigin: "provider-response",
			})?.source,
		).toBe("AUTHENTICATED_SUBMISSION");
	});
	it("retains authenticated text when later callbacks or internal failures arrive", () => {
		const retrieved = retrievedFailureDiagnostic(attempt, snapshot, result);
		const existing = { code: "RECONCILIATION_TERMINAL_UNVERIFIED", providerDiagnostic: retrieved };
		const callback = callbackFailureDiagnostic(attempt, snapshot, result, new Date(observedAt));
		expect(withProviderDiagnostic(existing, callback, attempt)).toEqual(existing);
		expect(
			withProviderDiagnostic({}, { ...retrieved!, attemptId: "other-attempt" }, attempt),
		).toEqual({});
	});
});
