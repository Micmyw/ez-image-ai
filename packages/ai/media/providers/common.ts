import type {
	NormalizedResult,
	ProviderFailure,
	ProviderOutput,
	ProviderTaskSnapshot,
	ProviderTaskStatus,
} from "../types";

export function normalizeStatus(value: string): ProviderTaskStatus {
	const status = value.toLowerCase();
	if (["starting", "pending", "queued", "in_queue", "waiting"].includes(status)) return "QUEUED";
	if (["processing", "running", "in_progress"].includes(status)) return "RUNNING";
	if (["succeeded", "success", "completed", "finished"].includes(status)) return "SUCCEEDED";
	if (["failed", "error"].includes(status)) return "FAILED";
	if (["canceled", "cancelled"].includes(status)) return "CANCELED";
	return "UNKNOWN";
}
export function failureFrom(message: string | undefined): ProviderFailure | null {
	if (!message) return null;
	const retryable = /rate|limit|timeout|temporar|unavailable|overload/i.test(message);
	return {
		code: retryable ? "PROVIDER_TEMPORARY" : "PROVIDER_REJECTED",
		message: message.slice(0, 500),
		retryable,
	};
}
export function remoteOutputs(values: string[]): ProviderOutput[] {
	return values.map((url) => ({ kind: "remote-url", url, trust: "untrusted-transfer-candidate" }));
}
export function normalizedResult(
	snapshot: ProviderTaskSnapshot,
	outputs: ProviderOutput[],
	failure: ProviderFailure | null,
	cost: number | null,
): NormalizedResult {
	return {
		outputs,
		progress: snapshot.progress ?? (snapshot.status === "SUCCEEDED" ? 100 : null),
		providerCostMicros: cost,
		failure,
		retryable: failure?.retryable ?? false,
		providerCharged: snapshot.status === "SUCCEEDED" || cost !== null,
	};
}
