/** Capacity observations do not authorize a refund, settlement, output, or resend. */
export type ProviderTerminalEvidence = {
	version: 1;
	provider: "kie";
	source: "kie-record-info";
	attemptId: string;
	providerTaskId: string;
	status: "SUCCEEDED" | "FAILED" | "CANCELED";
	verifiedAt: string;
};

export interface ProviderAttemptIdentity {
	id?: string;
	provider: string;
	providerTaskId?: string | null;
}

/** Validate persisted evidence against its row; shape alone cannot attest origin. */
export function readProviderTerminalEvidence(
	value: unknown,
	identity: ProviderAttemptIdentity,
): ProviderTerminalEvidence | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (
		record.version !== 1 ||
		record.provider !== "kie" ||
		identity.provider !== "kie" ||
		record.source !== "kie-record-info" ||
		!identifier(identity.id) ||
		record.attemptId !== identity.id ||
		!identifier(identity.providerTaskId) ||
		record.providerTaskId !== identity.providerTaskId ||
		typeof record.status !== "string" ||
		!["SUCCEEDED", "FAILED", "CANCELED"].includes(record.status) ||
		!canonicalTimestamp(record.verifiedAt)
	)
		return null;
	return {
		version: 1,
		provider: "kie",
		source: "kie-record-info",
		attemptId: identity.id,
		providerTaskId: identity.providerTaskId,
		status: record.status as ProviderTerminalEvidence["status"],
		verifiedAt: record.verifiedAt,
	};
}

/** Call only after the server adapter's authenticated retrieval and identity check.
 * Callback JSON and operator reason strings are deliberately not accepted. */
export function createRetrievedProviderTerminalEvidence(
	identity: ProviderAttemptIdentity,
	snapshot: {
		providerTaskId: string;
		status: string;
		retrieval?: { source: string; observedAt: string };
	},
	now = new Date(),
): ProviderTerminalEvidence | null {
	if (snapshot.providerTaskId !== identity.providerTaskId) return null;
	const evidence = readProviderTerminalEvidence(
		{
			version: 1,
			provider: identity.provider,
			source: snapshot.retrieval?.source,
			attemptId: identity.id,
			providerTaskId: snapshot.providerTaskId,
			status: snapshot.status,
			verifiedAt: snapshot.retrieval?.observedAt,
		},
		identity,
	);
	return evidence && Date.parse(evidence.verifiedAt) <= now.getTime() ? evidence : null;
}

function identifier(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function canonicalTimestamp(value: unknown): value is string {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
		return false;
	const milliseconds = Date.parse(value);
	return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}
