import type { MediaModelInput } from "./catalog/schemas";

export type ProviderKey = "replicate" | "fal" | "kie" | "gemini";
export type ProviderTaskStatus =
	| "UNKNOWN"
	| "QUEUED"
	| "RUNNING"
	| "SUCCEEDED"
	| "FAILED"
	| "CANCELED";
export type SubmissionOutcome = "accepted" | "rejected" | "uncertain";

export interface ResolvedMediaAsset {
	assetId: string;
	transferUrl: string;
}
export type ProviderExecutionInput =
	| Extract<MediaModelInput, { kind: "text-to-image" | "text-to-video" }>
	| (Omit<Extract<MediaModelInput, { kind: "image-to-image" }>, "sourceAssetId"> & {
			sourceAsset: ResolvedMediaAsset;
	  })
	| (Omit<Extract<MediaModelInput, { kind: "image-to-video" }>, "sourceAssetId"> & {
			sourceAsset: ResolvedMediaAsset;
	  });

export interface ProviderSubmitInput {
	attemptId: string;
	providerModelId: string;
	input: ProviderExecutionInput;
	webhookUrl?: string;
}
export interface ProviderSubmission {
	/** The only dispatch decision: accepted may proceed, rejected may fail over, uncertain must reconcile. */
	outcome: SubmissionOutcome;
	providerTaskId?: string;
	status: ProviderTaskStatus;
	failure?: ProviderFailure;
	idempotency: { key?: string; providerSupported: boolean; replayed: boolean };
	snapshot?: ProviderTaskSnapshot;
	reconciliation: {
		submissionToken: string;
		statusUrl?: string;
		resultUrl?: string;
	};
}
export interface ProviderRetrieveInput {
	providerTaskId: string;
	statusUrl?: string;
	resultUrl?: string;
}
export interface ProviderCancelInput {
	providerTaskId: string;
}
export interface ProviderCancelResult {
	status: ProviderTaskStatus;
	canceled: boolean;
}
export interface ProviderFailure {
	code: string;
	message: string;
	retryable: boolean;
}
export interface ProviderTaskSnapshot {
	providerTaskId: string;
	status: ProviderTaskStatus;
	progress?: number;
	raw: unknown;
}
export type ProviderOutput =
	| { kind: "remote-url"; url: string; trust: "untrusted-transfer-candidate" }
	| {
			kind: "inline-base64";
			mimeType: string;
			data: string;
			trust: "untrusted-transfer-candidate";
	  };
export interface NormalizedResult {
	outputs: ProviderOutput[];
	progress: number | null;
	providerCostMicros: number | null;
	failure: ProviderFailure | null;
	retryable: boolean;
	providerCharged: boolean;
}
export interface VerifiedProviderEvent {
	eventId: string;
	providerTaskId: string;
	status: ProviderTaskStatus;
	receivedAt: Date;
	providerOccurredAt?: Date;
	providerSequence?: bigint;
}
