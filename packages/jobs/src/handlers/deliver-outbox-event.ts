import type { OutboxLease } from "../contracts";

interface OutboxDeliveryDependencies {
	trigger(taskId: string, payload: Record<string, unknown>): Promise<void>;
	triggerAndWait?(taskId: string, payload: Record<string, unknown>): Promise<void>;
	resolveDispatchRoute(jobId: string): Promise<{ taskId: string }>;
}

export async function deliverOutboxEvent(
	event: OutboxLease,
	dependencies: OutboxDeliveryDependencies,
): Promise<void> {
	const payload = objectValue(event.payload);
	switch (event.eventType) {
		case "PAYMENT_EVENT_RECEIVED":
			return dependencies.trigger("media-process-payment-event", {
				paymentEventId: requiredString(payload.paymentEventId),
			});
		case "JOB_CREATED":
		case "GENERATION_DISPATCH": {
			const route = await dependencies.resolveDispatchRoute(event.aggregateId);
			return dependencies.trigger(route.taskId, {
				jobId: event.aggregateId,
				version: integerValue(payload.version, 0),
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
		case "GENERATION_CANCEL_REQUESTED":
			return dependencies.trigger("media-settle-generation", {
				jobId: event.aggregateId,
				version: integerValue(payload.version, 0),
			});
		case "MEDIA_ASSET_VERIFY":
		case "MEDIA_ASSET_MODERATION_REQUESTED":
			return dependencies.trigger("media-verify-upload", {
				assetId: requiredString(payload.assetId, event.aggregateId),
			});
		case "MEDIA_OBJECT_DELETE":
			return triggerCleanup(dependencies, "media-delete-object", {
				assetId: requiredString(payload.assetId, event.aggregateId),
				objectKey: requiredString(payload.objectKey),
			});
		case "MEDIA_MULTIPART_ABORT":
			return triggerCleanup(dependencies, "media-abort-multipart", {
				assetId: requiredString(payload.assetId, event.aggregateId),
				objectKey: requiredString(payload.objectKey),
				multipartUploadId: requiredString(payload.multipartUploadId),
			});
		default:
			throw new Error(`Unsupported outbox event type: ${event.eventType}`);
	}
}

function triggerCleanup(
	dependencies: OutboxDeliveryDependencies,
	taskId: string,
	payload: Record<string, unknown>,
): Promise<void> {
	if (!dependencies.triggerAndWait) throw new Error("Cleanup task waiter is unavailable");
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
