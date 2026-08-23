export const QUEUE_NAMES = {
	imageSubmission: "media-image-submission",
	videoSubmission: "media-video-submission",
	finalization: "media-finalization",
	settlementRecovery: "media-settlement-recovery",
} as const;

export interface MediaQueueLimits {
	imageSubmission: number;
	videoSubmission: number;
	finalization: number;
	settlementRecovery: number;
	providers: Partial<Record<string, number>>;
	models: Record<string, number>;
}

export function parseMediaQueueLimits(
	environment: Record<string, string | undefined>,
): MediaQueueLimits {
	return {
		imageSubmission: positiveInteger(environment.MEDIA_IMAGE_SUBMISSION_CONCURRENCY, 4),
		videoSubmission: positiveInteger(environment.MEDIA_VIDEO_SUBMISSION_CONCURRENCY, 2),
		finalization: positiveInteger(environment.MEDIA_FINALIZATION_CONCURRENCY, 3),
		settlementRecovery: positiveInteger(environment.MEDIA_RECOVERY_CONCURRENCY, 2),
		providers: parseLimits(environment.MEDIA_PROVIDER_QUEUE_LIMITS),
		models: parseLimits(environment.MEDIA_MODEL_QUEUE_LIMITS),
	};
}

export function providerQueueKey(provider: string, providerModelId: string): string {
	return `${provider}:${providerModelId}`.replace(/[^A-Za-z0-9:_-]/g, "_").slice(0, 120);
}

export function dispatchRouteFor(
	mediaKind: "image" | "video",
	provider: string,
	providerModelId: string,
): { taskId: string; queueName: string } {
	const routeKey = providerQueueKey(provider, providerModelId).replaceAll(":", "-");
	return {
		taskId: `media-dispatch-${mediaKind}-${routeKey}`.slice(0, 120),
		queueName: `media-${mediaKind}-${routeKey}`.slice(0, 120),
	};
}

function parseLimits(value: string | undefined): Record<string, number> {
	if (!value) return {};
	return Object.fromEntries(
		value.split(",").flatMap((entry) => {
			const separator = entry.lastIndexOf("=");
			if (separator <= 0) return [];
			const key = entry.slice(0, separator).trim();
			const limit = Number(entry.slice(separator + 1));
			return key && Number.isSafeInteger(limit) && limit > 0 ? [[key, limit]] : [];
		}),
	);
}

function positiveInteger(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
