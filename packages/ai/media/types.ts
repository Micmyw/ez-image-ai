import type { MediaModelInput } from "./catalog/schemas";

export type ProviderKey = "replicate" | "fal" | "kie" | "gemini" | "openrouter";
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
export interface SubmissionUncertainty {
	classification: "ambiguous_http" | "malformed_2xx" | "transport";
	phase: "post_send";
	statusCode?: number;
}

interface ProviderSubmissionBase {
	providerTaskId?: string;
	status: ProviderTaskStatus;
	idempotency: { key?: string; providerSupported: boolean; replayed: boolean };
	snapshot?: ProviderTaskSnapshot;
	reconciliation: {
		submissionToken: string;
		statusUrl?: string;
		resultUrl?: string;
	};
}
export type ProviderSubmission =
	| (ProviderSubmissionBase & {
			/** Accepted may proceed to provider polling or finalization. */
			outcome: "accepted";
			failure?: never;
			uncertainty?: never;
	  })
	| (ProviderSubmissionBase & {
			/** Rejected may fail over only when its provider failure is retryable. */
			outcome: "rejected";
			failure: ProviderFailure;
			uncertainty?: never;
	  })
	| (ProviderSubmissionBase & {
			/** Uncertain submissions must reconcile and retain only bounded recovery evidence. */
			outcome: "uncertain";
			failure?: ProviderFailure;
			uncertainty: SubmissionUncertainty;
	  });
export interface ProviderRetrieveInput {
	providerTaskId: string;
	statusUrl?: string;
	resultUrl?: string;
}
export interface ProviderCancelInput {
	providerTaskId: string;
	idempotencyKey: string;
}
export interface ProviderCancelResult {
	status: ProviderTaskStatus;
	canceled: boolean;
	noCharge: boolean;
	retryable: boolean;
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
