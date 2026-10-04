import type { VideoModelInput } from "@repo/config/video-models";
import type { VideoAudioSafetyPolicy } from "@repo/config/video-output";
import type { VideoVisualSafetyProfile } from "@repo/config/video-safety";
import type { VideoTextSafetyProfile } from "@repo/config/video-text-safety";

/** The one public contract for the isolated video V1 engine. Never expose provider URLs. */
export const VIDEO_EXECUTION_ENGINE = "video-workflow-v1" as const;
export type VideoExecutionEngine = typeof VIDEO_EXECUTION_ENGINE;
export type VideoMode = "text-to-video" | "image-to-video";
export type VideoStage =
	| "QUEUED"
	| "INPUT_REVIEW"
	| "SUBMITTING"
	| "SUBMISSION_UNCERTAIN"
	| "GENERATING"
	| "STORING"
	| "OUTPUT_REVIEW"
	| "FINALIZING"
	| "READY"
	| "REJECTED"
	| "FAILED"
	| "NEEDS_REVIEW";
export type VideoWorkflowParams = { jobId: string; schemaVersion: 1 };
export type VideoStartState = "PENDING" | "STARTED" | "FAILED";
export type VideoPublicState = {
	jobId: string;
	stage: VideoStage;
	creditState: "RESERVED" | "SETTLED" | "RELEASED";
	credits: string;
	canPlay: boolean;
	failureCode: string | null;
	updatedAt: string;
};
export interface VideoWorkflowInstance {
	status(): Promise<{ status: string }>;
	sendEvent(event: {
		type: "provider-result" | "moderation-result";
		payload: Record<string, unknown>;
	}): Promise<void>;
}
export interface VideoWorkflowBinding {
	create(options: { id: string; params: VideoWorkflowParams }): Promise<VideoWorkflowInstance>;
	get(id: string): Promise<VideoWorkflowInstance>;
}
export type ReviewStepResult =
	| { status: "ALLOW" }
	| { status: "REJECT"; reasonCode: string }
	| {
			status: "PENDING";
			retryAfterSeconds?: number;
			deadlineAt?: string;
			nextRetryAt?: string;
			waitFor?: "callback" | "confirmation-retry";
	  }
	| { status: "ERROR"; reasonCode: string; retryable?: boolean };
export type SubmissionStepResult =
	| { status: "ACCEPTED"; attemptId: string; providerTaskId: string }
	| { status: "UNCERTAIN"; attemptId: string; reasonCode: string }
	| { status: "DEFINITELY_REJECTED"; attemptId?: string; reasonCode: string };
export type ProviderResult =
	| { status: "PENDING"; retryAfterSeconds?: number; deadlineAt?: string }
	| { status: "SUCCEEDED"; attemptId: string }
	| { status: "FAILED"; reasonCode: string };
export type StoredOutputRef = { assetId: string; checksum: string; byteSize: string };
export type AcceptedWebhookResult = {
	accepted: boolean;
	replayed: boolean;
	notified: boolean;
	jobId?: string;
};
export type RecoverySummary = {
	inspected: number;
	started: number;
	notified: number;
	failed: number;
};
export type VideoRequestInput =
	| VideoModelInput
	| {
			mode: "text-to-video";
			prompt: string;
			duration: 5;
			sound: false;
			aspectRatio: "16:9" | "9:16";
	  }
	| { mode: "image-to-video"; prompt: string; duration: 5; sound: false; inputAssetId: string };
export type VideoInputIdentity = {
	assetId: string;
	checksum: string;
	objectKey: string;
	storageEtag: string | null;
	storageVersionId: string | null;
	verificationGeneration: number;
};
export type VideoInputSnapshot = VideoRequestInput & {
	visualSafetyProfile?: VideoVisualSafetyProfile;
	textSafetyProfile?: VideoTextSafetyProfile;
	audioSafetyPolicy?: VideoAudioSafetyPolicy;
	schemaVersion: 1;
	modelContractVersion: string;
	requestFingerprint: string;
	inputIdentity: VideoInputIdentity | null;
};
export type CreateVideoJobInput = {
	quoteId: string;
	idempotencyKey: string;
	request: VideoRequestInput;
};
export type VideoOwnerContext = { userId: string; role?: string | null };
