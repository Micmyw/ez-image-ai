import type { ProviderKey } from "@repo/ai";

import type { OutboxLease } from "../contracts";

interface OutboxDeliveryDependencies {
	trigger(taskId: string, payload: Record<string, unknown>): Promise<void>;
	triggerAndWait?(taskId: string, payload: Record<string, unknown>): Promise<void>;
	resolveDispatchRoute(jobId: string): Promise<{
		taskId: string;
		provider: ProviderKey;
		providerModelId: string;
	} | null>;
}

export async function deliverOutboxEvent(
	event: OutboxLease,
	dependencies: OutboxDeliveryDependencies,
): Promise<void> {
	const payload = objectValue(event.payload);
	switch (event.eventType) {
		case "GUEST_GENERATION_ELIGIBLE":
			return triggerAndWait(dependencies, "media-admit-guest-generation", {
				jobId: requiredString(payload.jobId, event.aggregateId),
				trialId: requiredString(payload.trialId),
			});
		case "PAYMENT_EVENT_RECEIVED":
			return dependencies.trigger("media-process-payment-event", {
				paymentEventId: requiredString(payload.paymentEventId),
			});
		case "JOB_CREATED":
		case "GENERATION_DISPATCH": {
			const route = await dependencies.resolveDispatchRoute(event.aggregateId);
			if (!route) return;
			return dependencies.trigger(route.taskId, {
				jobId: event.aggregateId,
				version: integerValue(payload.version, 0),
				provider: route.provider,
				providerModelId: route.providerModelId,
			});
		}
		case "PROVIDER_EVENT_RECEIVED":
			return dependencies.trigger("media-process-provider-webhook", {
				providerWebhookEventId: requiredString(payload.providerWebhookEventId),
			});
		case "GENERATION_FINALIZE":
		case "GENERATION_FINALIZE_RETRY":
			return dependencies.trigger("media-finalize-generation", {
				jobId: event.aggregateId,
				version: integerValue(payload.version, 0),
			});
		case "GENERATION_SETTLE":
			return dependencies.trigger("media-settle-generation", {
				jobId: event.aggregateId,
				version: integerValue(payload.version, 0),
			});
		case "GENERATION_CANCEL_REQUESTED":
			return triggerAndWait(dependencies, "media-cancel-generation", {
				jobId: event.aggregateId,
				version: integerValue(payload.version, 0),
			});
		case "MEDIA_ASSET_LEGACY_REVERIFY":
			return dependencies.trigger("media-verify-upload", {
				assetId: requiredString(payload.assetId, event.aggregateId),
				allowQuarantinedReverification: true,
			});
		case "MEDIA_ASSET_VERIFY":
		case "MEDIA_ASSET_MODERATION_REQUESTED":
			return dependencies.trigger("media-verify-upload", {
				assetId: requiredString(payload.assetId, event.aggregateId),
				...(payload.allowQuarantinedReverification === true
					? { allowQuarantinedReverification: true }
					: {}),
			});
		case "MEDIA_OBJECT_DELETE":
			return triggerCleanup(dependencies, "media-delete-object", {
				assetId: requiredString(payload.assetId, event.aggregateId),
				objectKey: requiredString(payload.objectKey),
				...cleanupObjectKeysPayload(payload),
				...cleanupReservationPayload(payload),
				...generatedOutputReservationPayload(payload, event.aggregateId),
			});
		case "MEDIA_MULTIPART_ABORT":
			return triggerCleanup(dependencies, "media-abort-multipart", {
				assetId: requiredString(payload.assetId, event.aggregateId),
				objectKey: requiredString(payload.objectKey),
				multipartUploadId: requiredString(payload.multipartUploadId),
				...cleanupObjectKeysPayload(payload),
				...cleanupReservationPayload(payload),
			});
		case "MEDIA_UPLOAD_CLEANUP":
			return triggerUploadCleanup(event, payload, dependencies);
		default:
			throw new Error(`Unsupported outbox event type: ${event.eventType}`);
	}
}

function triggerUploadCleanup(
	event: OutboxLease,
	payload: Record<string, unknown>,
	dependencies: OutboxDeliveryDependencies,
): Promise<void> {
	const cleanupPayload = {
		assetId: requiredString(payload.assetId, event.aggregateId),
		objectKey: requiredString(payload.objectKey),
		...cleanupObjectKeysPayload(payload),
		...cleanupReservationPayload(payload),
		...generatedOutputReservationPayload(payload, event.aggregateId),
	};
	const multipartUploadId =
		typeof payload.multipartUploadId === "string" ? payload.multipartUploadId : undefined;
	if (payload.promotionAbortOnly === true) {
		return triggerCleanup(dependencies, "media-abort-promotion-multipart", {
			assetId: requiredString(payload.assetId, event.aggregateId),
			objectKey: requiredString(payload.objectKey),
			multipartUploadId: requiredString(multipartUploadId),
			promotionAbortOnly: true,
		});
	}
	const promotionObjectKey =
		typeof payload.promotionObjectKey === "string" ? payload.promotionObjectKey : undefined;
	if (promotionObjectKey) {
		return triggerCleanup(dependencies, "media-cleanup-upload-promotion", {
			...cleanupPayload,
			promotionObjectKey,
			...(typeof payload.promotionMultipartUploadId === "string"
				? { promotionMultipartUploadId: payload.promotionMultipartUploadId }
				: {}),
			...(multipartUploadId ? { multipartUploadId } : {}),
		});
	}
	return multipartUploadId
		? triggerCleanup(dependencies, "media-abort-multipart", {
				...cleanupPayload,
				multipartUploadId,
			})
		: triggerCleanup(dependencies, "media-delete-object", cleanupPayload);
}

function cleanupObjectKeysPayload(payload: Record<string, unknown>): {
	cleanupObjectKeys?: string[];
} {
	const cleanupObjectKeys = Array.isArray(payload.cleanupObjectKeys)
		? payload.cleanupObjectKeys.filter(
				(value): value is string => typeof value === "string" && value.length > 0,
			)
		: [];
	return cleanupObjectKeys.length ? { cleanupObjectKeys } : {};
}

function triggerCleanup(
	dependencies: OutboxDeliveryDependencies,
	taskId: string,
	payload: Record<string, unknown>,
): Promise<void> {
	return triggerAndWait(dependencies, taskId, payload);
}

function triggerAndWait(
	dependencies: OutboxDeliveryDependencies,
	taskId: string,
	payload: Record<string, unknown>,
): Promise<void> {
	if (!dependencies.triggerAndWait) throw new Error("Task waiter is unavailable");
	return dependencies.triggerAndWait(taskId, payload);
}

function objectValue(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function integerValue(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isSafeInteger(value) ? value : fallback;
}

function requiredString(value: unknown, fallback?: string): string {
	const resolved = typeof value === "string" && value ? value : fallback;
	if (!resolved) throw new Error("Outbox payload omitted internal ID");
	return resolved;
}

function cleanupReservationPayload(payload: Record<string, unknown>): {
	uploadSessionId?: string;
	reservationStatus?: "EXPIRED" | "RELEASED";
} {
	const uploadSessionId =
		typeof payload.uploadSessionId === "string" ? payload.uploadSessionId : undefined;
	const reservationStatus =
		payload.reservationStatus === "EXPIRED" || payload.reservationStatus === "RELEASED"
			? payload.reservationStatus
			: undefined;
	return {
		...(uploadSessionId && reservationStatus ? { uploadSessionId, reservationStatus } : {}),
	};
}

function generatedOutputReservationPayload(
	payload: Record<string, unknown>,
	assetIdFallback: string,
): { storageReservationReferenceKey?: string } {
	if (payload.storageReservationReferenceKey === undefined) return {};
	const assetId = requiredString(payload.assetId, assetIdFallback);
	const expectedReferenceKey = `generation-output:${assetId}`;
	if (payload.storageReservationReferenceKey !== expectedReferenceKey) {
		throw new Error("Generated output storage reservation reference is invalid");
	}
	return { storageReservationReferenceKey: expectedReferenceKey };
}
