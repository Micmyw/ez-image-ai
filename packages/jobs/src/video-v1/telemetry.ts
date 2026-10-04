/** Only stable IDs, controlled stages/codes and durations may enter diagnostic logs. */
export interface VideoStageTiming {
	requestReceivedAt: string | null;
	admissionTransactionStartedAt: string | null;
	providerCapacityLockRequestedAt: string | null;
	providerCapacityLockAcquiredAt: string | null;
	creditReservationStartedAt: string | null;
	creditReservationCompletedAt: string | null;
	jobReservationWrittenAt: string | null;
	jobReservedAt: string | null;
	workflowCreateRequestedAt: string | null;
	workflowStartedAt: string | null;
	inputReviewStartedAt: string | null;
	inputReviewCompletedAt: string | null;
	providerSubmitStartedAt: string | null;
	providerAcceptedAt: string | null;
	providerCompletedAt: string | null;
	providerCallbackReceivedAt: string | null;
	/** Application observation immediately after callback inbox COMMIT acknowledgement. */
	providerCallbackPersistedAt: string | null;
	providerResultConfirmedAt: string | null;
	storageStartedAt: string | null;
	storageCompletedAt: string | null;
	outputReviewStartedAt: string | null;
	outputReviewCompletedAt: string | null;
	readyAt: string | null;
}
export function videoDurationMs(
	start: string | null | undefined,
	end: string | null | undefined,
): number | null {
	if (!start || !end) return null;
	const duration = Date.parse(end) - Date.parse(start);
	return Number.isFinite(duration) && duration >= 0 ? duration : null;
}
export function videoStageDurations(t: VideoStageTiming) {
	return {
		admissionMs: videoDurationMs(t.requestReceivedAt, t.jobReservedAt),
		admissionQueueMs: videoDurationMs(t.requestReceivedAt, t.admissionTransactionStartedAt),
		admissionLockWaitMs: videoDurationMs(
			t.providerCapacityLockRequestedAt,
			t.providerCapacityLockAcquiredAt,
		),
		admissionLockedWorkMs: videoDurationMs(
			t.providerCapacityLockAcquiredAt,
			t.jobReservationWrittenAt,
		),
		creditReservationMs: videoDurationMs(
			t.creditReservationStartedAt,
			t.creditReservationCompletedAt,
		),
		workflowStartMs: videoDurationMs(t.jobReservedAt, t.workflowStartedAt),
		inputReviewMs: videoDurationMs(t.inputReviewStartedAt, t.inputReviewCompletedAt),
		inputToSubmissionMs: videoDurationMs(t.inputReviewCompletedAt, t.providerSubmitStartedAt),
		providerRequestMs: videoDurationMs(t.providerSubmitStartedAt, t.providerAcceptedAt),
		providerGenerationMs: videoDurationMs(t.providerAcceptedAt, t.providerCompletedAt),
		resultDiscoveryMs: videoDurationMs(t.providerCompletedAt, t.providerResultConfirmedAt),
		callbackToConfirmationMs: videoDurationMs(
			t.providerCallbackReceivedAt,
			t.providerResultConfirmedAt,
		),
		callbackPersistedToConfirmationMs: videoDurationMs(
			t.providerCallbackPersistedAt,
			t.providerResultConfirmedAt,
		),
		storageMs: videoDurationMs(t.storageStartedAt, t.storageCompletedAt),
		outputReviewMs: videoDurationMs(t.outputReviewStartedAt, t.outputReviewCompletedAt),
		finalizationMs: videoDurationMs(t.outputReviewCompletedAt, t.readyAt),
	};
}

export function recordVideoStageMetric(input: {
	jobId: string;
	attemptId?: string;
	stage: string;
	durationMs: number | null;
	errorCode?: string;
}) {
	console.info("video-v1.stage", {
		jobId: input.jobId,
		...(input.attemptId ? { attemptId: input.attemptId } : {}),
		stage: input.stage,
		durationMs: input.durationMs,
		...(input.errorCode
			? {
					errorCode: /^[A-Z0-9_]{1,100}$/.test(input.errorCode)
						? input.errorCode
						: "VIDEO_STAGE_ERROR",
				}
			: {}),
	});
}
