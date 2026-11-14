import { kieZeroCostRejectionEvidenceSchema } from "@repo/config/kie-zero-cost-rejection";
import { readProviderDiagnostic } from "@repo/config/provider-diagnostics";
import { readProviderTerminalEvidence } from "@repo/config/provider-terminal-evidence";

export function diagnosticObject(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/** Only selected diagnostic leaves pass here; never stringify arbitrary envelopes. */
export function safeDiagnosticText(value: unknown, maximum = 500): string | null {
	if (typeof value !== "string" || !value.trim()) return null;
	return value
		.slice(0, 32_768)
		.replace(/\\u00(2f|3a)/gi, (_match, hex: string) =>
			String.fromCharCode(Number.parseInt(hex, 16)),
		)
		.replace(/\\\//g, "/")
		.replace(/-----BEGIN[\s\S]*?(?:-----END[^\r\n]*|$)/g, "[redacted credential]")
		.replace(/(?:https?|s3|r2):\/\/[^\s<>"']+/gi, "[redacted URL]")
		.replace(/(?:https?|s3|r2)%3a(?:%2f){2}[^\s<>"']*/gi, "[redacted URL]")
		.replace(/data:[^\s<>"']+/gi, "[redacted URL]")
		.replace(/\b(?:Bearer|Basic|Authorization\s+Key)\s+[^\s,;"'}]+/gi, "[redacted credential]")
		.replace(
			/\b(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|authorization|signature|secret|password|credential|token)\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}>]+)/gi,
			"[redacted credential]",
		)
		.replace(/\b(?:sk|rk|pk)_[a-z0-9_-]{12,}\b|\bsk-[a-z0-9_-]{12,}\b/gi, "[redacted credential]")
		.replace(
			/\b(?:users|organizations|temporary-references|guests)\/[^\s<>"']+/gi,
			"[redacted object]",
		)
		.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)?/g, "[redacted credential]")
		.replace(/\b[A-Za-z0-9_+/=.-]{32,}\b/g, "[redacted identifier]")
		.replace(
			// eslint-disable-next-line no-control-regex -- Remove control and direction-override characters from untrusted diagnostics.
			/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
			"",
		)
		.slice(0, maximum);
}

export function safeDiagnosticCode(value: unknown, maximum = 160): string | null {
	return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,159}$/.test(value)
		? value.slice(0, maximum)
		: safeDiagnosticText(value, maximum);
}
export function safeDiagnosticIdentifier(value: unknown, maximum = 160): string | null {
	return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
		? value.slice(0, maximum)
		: null;
}

export function diagnosticLabels(value: unknown): string[] {
	return Array.isArray(value)
		? value
				.flatMap((item) => {
					const text = safeDiagnosticText(item, 128);
					return text ? [text] : [];
				})
				.slice(0, 100)
		: [];
}

export function promptReviewProjection(value: unknown, createdAt: Date, id: string) {
	const data = diagnosticObject(value);
	const evidence = diagnosticObject(data.evidence);
	const waffo = diagnosticObject(evidence.waffo);
	const seeapi = diagnosticObject(evidence.seeapiText);
	const seeapiCategories = Object.entries(diagnosticObject(seeapi.categories))
		.filter(([, category]) => diagnosticObject(category).flagged === true)
		.map(([category]) => category);
	return {
		id,
		createdAt,
		provider: safeDiagnosticText(data.provider, 80) ?? "unknown",
		decision: safeDiagnosticText(data.decision, 80) ?? "UNKNOWN",
		reasonCode: safeDiagnosticCode(data.reasonCode),
		action: safeDiagnosticText(waffo.action, 80),
		semanticStatus: safeDiagnosticText(waffo.semanticStatus, 80),
		categories: diagnosticLabels(evidence.seeapiText ? seeapiCategories : waffo.matchedCategories),
	};
}

export function attemptProjection(attempt: {
	id: string;
	provider: string;
	providerTaskId: string | null;
	status: string;
	uncertainSubmission: boolean;
	responseSnapshot: unknown;
	errorSnapshot: unknown;
	createdAt: Date;
}) {
	const response = diagnosticObject(attempt.responseSnapshot);
	const failure = diagnosticObject(attempt.errorSnapshot);
	const terminal = readProviderTerminalEvidence(response.providerTerminalEvidence, attempt);
	const diagnostic = readProviderDiagnostic(failure.providerDiagnostic, attempt);
	const rejection = kieZeroCostRejectionEvidenceSchema.safeParse(
		response.confirmedZeroCostRejection,
	);
	const rejectionEvidence =
		rejection.success &&
		attempt.provider === "kie" &&
		rejection.data.taskId === attempt.providerTaskId
			? rejection.data
			: null;
	// A callback or free-form provider response is never upgraded to authenticated evidence.
	return {
		id: attempt.id,
		provider: safeDiagnosticText(attempt.provider, 80) ?? "unknown",
		providerTaskId: safeDiagnosticIdentifier(attempt.providerTaskId),
		status: attempt.status,
		uncertainSubmission: attempt.uncertainSubmission,
		createdAt: attempt.createdAt,
		errorCode: safeDiagnosticCode(failure.code),
		errorMessage:
			diagnostic?.message ?? safeDiagnosticText(rejectionEvidence?.failMsg ?? failure.message),
		messageSource:
			diagnostic?.source ??
			(rejectionEvidence?.source === "record-info"
				? ("AUTHENTICATED_RETRIEVAL" as const)
				: rejectionEvidence?.source === "dashboard-log"
					? ("ADMIN_ATTESTATION" as const)
					: ("STORED_DIAGNOSTIC" as const)),
		messageObservedAt: diagnostic?.observedAt ?? rejectionEvidence?.observedAt ?? null,
		terminalStatus: terminal?.status ?? null,
		verifiedAt: terminal?.verifiedAt ?? null,
		evidenceSource: terminal
			? ("AUTHENTICATED_RETRIEVAL" as const)
			: ("STORED_DIAGNOSTIC" as const),
	};
}
