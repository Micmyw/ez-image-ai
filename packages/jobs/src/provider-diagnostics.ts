import type { NormalizedResult, ProviderFailure, ProviderTaskSnapshot } from "@repo/ai";
import {
	createProviderDiagnostic,
	readProviderDiagnostic,
	type ProviderDiagnostic,
	type ProviderDiagnosticIdentity,
} from "@repo/config/provider-diagnostics";

/** Diagnostic provenance never changes terminal evidence, retry or billing predicates. */
export function submissionFailureDiagnostic(
	attempt: ProviderDiagnosticIdentity,
	failure: ProviderFailure,
): ProviderDiagnostic | null {
	return createProviderDiagnostic(attempt, {
		message: failure.message,
		source:
			failure.messageOrigin === "provider-response"
				? "AUTHENTICATED_SUBMISSION"
				: "INTERNAL_DIAGNOSTIC",
	});
}

export function retrievedFailureDiagnostic(
	attempt: ProviderDiagnosticIdentity,
	snapshot: ProviderTaskSnapshot,
	result: NormalizedResult,
): ProviderDiagnostic | null {
	if (!terminalFailureForAttempt(attempt, snapshot, result)) return null;
	const trustedSource =
		(attempt.provider === "kie" &&
			["kie-record-info", "kie-veo-record-info", "kie-legacy-record-info"].includes(
				snapshot.retrieval?.source ?? "",
			)) ||
		(attempt.provider === "fal" && snapshot.retrieval?.source === "fal-status") ||
		(attempt.provider === "replicate" && snapshot.retrieval?.source === "replicate-prediction");
	return createProviderDiagnostic(attempt, {
		message: result.failure?.message,
		source: trustedSource ? "AUTHENTICATED_RETRIEVAL" : "INTERNAL_DIAGNOSTIC",
		...(trustedSource ? { observedAt: snapshot.retrieval!.observedAt } : {}),
	});
}

export function callbackFailureDiagnostic(
	attempt: ProviderDiagnosticIdentity,
	snapshot: ProviderTaskSnapshot,
	result: NormalizedResult,
	receivedAt: Date,
): ProviderDiagnostic | null {
	if (!terminalFailureForAttempt(attempt, snapshot, result)) return null;
	return createProviderDiagnostic(attempt, {
		message: result.failure?.message,
		source: "CALLBACK_DIAGNOSTIC",
		observedAt: receivedAt.toISOString(),
	});
}

/** A late callback must not replace text obtained by authenticated retrieval. */
export function withProviderDiagnostic(
	existing: unknown,
	diagnostic: ProviderDiagnostic | null,
	attempt: ProviderDiagnosticIdentity,
): Record<string, unknown> {
	const snapshot =
		existing && typeof existing === "object" && !Array.isArray(existing)
			? (existing as Record<string, unknown>)
			: {};
	const previous = readProviderDiagnostic(snapshot.providerDiagnostic, attempt);
	const candidate = readProviderDiagnostic(diagnostic, attempt);
	if (
		!candidate ||
		(previous?.source === "AUTHENTICATED_RETRIEVAL" &&
			candidate.source !== "AUTHENTICATED_RETRIEVAL")
	)
		return snapshot;
	return { ...snapshot, providerDiagnostic: candidate };
}

function terminalFailureForAttempt(
	attempt: ProviderDiagnosticIdentity,
	snapshot: ProviderTaskSnapshot,
	result: NormalizedResult,
): boolean {
	return Boolean(
		result.failure &&
		attempt.providerTaskId &&
		snapshot.providerTaskId === attempt.providerTaskId &&
		(snapshot.status === "FAILED" || snapshot.status === "CANCELED"),
	);
}
