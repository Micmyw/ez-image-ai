import { videoDurationMs } from "./telemetry";

function object(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
function timestamp(value: unknown): string | null {
	if (!(value instanceof Date) && typeof value !== "string") return null;
	const millis = value instanceof Date ? value.getTime() : Date.parse(value);
	return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

/** Admin-only timings: measured timestamps, never invented progress or supplier evidence. */
export function videoTemplateDiagnosticsTimings(executionValue: unknown, templateValue: unknown) {
	const execution = object(executionValue);
	const template = object(templateValue);
	const executionTimes = object(object(execution.stageData).timings);
	const templateTimes = object(template.stageData);
	const timings = {
		requestReceivedAt: timestamp(executionTimes.requestReceivedAt),
		reservationCommittedAt: timestamp(executionTimes.jobReservedAt),
		inputReviewCompletedAt: timestamp(templateTimes.inputReviewCompletedAt),
		sceneSubmitStartedAt: timestamp(template.submittedAt),
		sceneAcceptedAt: timestamp(template.acceptedAt),
		sceneProviderCompletedAt: timestamp(template.completedAt),
		sceneStoredAt: timestamp(templateTimes.sceneStoredAt),
		sceneReviewCompletedAt: timestamp(templateTimes.sceneReviewCompletedAt),
		resolvedVideoInputSealedAt: timestamp(template.resolvedAt),
		videoSubmitStartedAt: timestamp(execution.providerSubmitStartedAt),
		videoAcceptedAt: timestamp(execution.providerAcceptedAt),
		videoProviderCompletedAt: timestamp(execution.providerCompletedAt),
		videoStorageStartedAt: timestamp(execution.storageStartedAt),
		videoStoredAt: timestamp(execution.storageCompletedAt),
		videoReviewStartedAt: timestamp(execution.outputReviewStartedAt),
		videoReviewCompletedAt: timestamp(execution.outputReviewCompletedAt),
		readyAt: timestamp(execution.readyAt),
	};
	return {
		timings,
		durations: {
			admissionMs: videoDurationMs(timings.requestReceivedAt, timings.reservationCommittedAt),
			inputPreparationMs: videoDurationMs(
				timings.reservationCommittedAt,
				timings.inputReviewCompletedAt,
			),
			sceneRequestMs: videoDurationMs(timings.sceneSubmitStartedAt, timings.sceneAcceptedAt),
			sceneProviderWaitMs: videoDurationMs(
				timings.sceneAcceptedAt,
				timings.sceneProviderCompletedAt,
			),
			sceneTransferMs: videoDurationMs(timings.sceneProviderCompletedAt, timings.sceneStoredAt),
			sceneReviewMs: videoDurationMs(timings.sceneStoredAt, timings.sceneReviewCompletedAt),
			sceneSealMs: videoDurationMs(
				timings.sceneReviewCompletedAt,
				timings.resolvedVideoInputSealedAt,
			),
			sceneToVideoSchedulingMs: videoDurationMs(
				timings.resolvedVideoInputSealedAt,
				timings.videoSubmitStartedAt,
			),
			videoRequestMs: videoDurationMs(timings.videoSubmitStartedAt, timings.videoAcceptedAt),
			videoProviderWaitMs: videoDurationMs(
				timings.videoAcceptedAt,
				timings.videoProviderCompletedAt,
			),
			videoTransferMs: videoDurationMs(timings.videoStorageStartedAt, timings.videoStoredAt),
			videoReviewMs: videoDurationMs(timings.videoReviewStartedAt, timings.videoReviewCompletedAt),
			finalizationMs: videoDurationMs(timings.videoReviewCompletedAt, timings.readyAt),
			totalMs: videoDurationMs(timings.requestReceivedAt, timings.readyAt),
		},
	};
}
