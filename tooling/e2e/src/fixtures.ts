import type {
	MediaProviderAdapter,
	NormalizedResult,
	ProviderCancelInput,
	ProviderCancelResult,
	ProviderSubmitInput,
	ProviderSubmission,
	ProviderTaskSnapshot,
	ProviderKey,
} from "@repo/ai";

export const E2E_PASSWORD = "LocalMediaE2E!2026";

// A valid 1x1 transparent PNG. It is small enough to make the storage path fast and deterministic.
export const E2E_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
	"base64",
);

export function fundedEmail(runId: string): string {
	return `media-e2e-funded-${runId}@example.test`;
}

export function emptyEmail(runId: string): string {
	return `media-e2e-empty-${runId}@example.test`;
}

export function scenarioFromPrompt(prompt: string): MediaE2EScenario {
	if (prompt.includes("[e2e:provider-failure]")) return "provider-failure";
	if (prompt.includes("[e2e:moderation-rejection]")) return "moderation-rejection";
	if (prompt.includes("[e2e:cancel-pending]")) return "cancel-pending";
	if (prompt.includes("[e2e:delayed-success]")) return "delayed-success";
	return "success";
}

export type MediaE2EScenario =
	| "success"
	| "provider-failure"
	| "moderation-rejection"
	| "cancel-pending"
	| "delayed-success";

export class LocalMediaE2EProvider implements MediaProviderAdapter {
	constructor(readonly provider: ProviderKey) {}

	async submit(input: ProviderSubmitInput): Promise<ProviderSubmission> {
		const scenario = scenarioFromPrompt(input.input.prompt);
		const providerTaskId = `e2e-${input.attemptId}`;
		if (scenario === "provider-failure") {
			return {
				status: "FAILED",
				failure: {
					code: "E2E_PROVIDER_FAILURE",
					message: "Deterministic failure",
					retryable: false,
				},
				idempotency: { key: input.attemptId, providerSupported: true, replayed: false },
				outcome: "rejected",
				reconciliation: { submissionToken: input.attemptId },
			};
		}
		if (scenario === "delayed-success" || scenario === "cancel-pending") {
			return {
				providerTaskId,
				status: "QUEUED",
				idempotency: { key: input.attemptId, providerSupported: true, replayed: false },
				outcome: "accepted",
				reconciliation: { submissionToken: input.attemptId },
			};
		}
		const snapshot = successSnapshot(providerTaskId);
		return {
			providerTaskId,
			status: "SUCCEEDED",
			snapshot,
			idempotency: { key: input.attemptId, providerSupported: true, replayed: false },
			outcome: "accepted",
			reconciliation: { submissionToken: input.attemptId },
		};
	}

	async retrieve(input: { providerTaskId: string }): Promise<ProviderTaskSnapshot> {
		return successSnapshot(input.providerTaskId);
	}

	async cancel(_input: ProviderCancelInput): Promise<ProviderCancelResult> {
		return { status: "CANCELED", canceled: true, noCharge: true, retryable: false };
	}

	async normalizeResult(snapshot: ProviderTaskSnapshot): Promise<NormalizedResult> {
		return snapshot.status === "FAILED"
			? {
					outputs: [],
					progress: 100,
					providerCostMicros: 0,
					failure: {
						code: "E2E_PROVIDER_FAILURE",
						message: "Deterministic failure",
						retryable: false,
					},
					retryable: false,
					providerCharged: false,
				}
			: {
					outputs: [
						{
							kind: "inline-base64",
							mimeType: "image/png",
							data: E2E_PNG.toString("base64"),
							trust: "untrusted-transfer-candidate",
						},
					],
					progress: 100,
					providerCostMicros: 100,
					failure: null,
					retryable: false,
					providerCharged: true,
				};
	}
}

function successSnapshot(providerTaskId: string): ProviderTaskSnapshot {
	return { providerTaskId, status: "SUCCEEDED", progress: 100, raw: { status: "succeeded" } };
}
