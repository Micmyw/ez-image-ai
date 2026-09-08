import { STATIC_DISPATCH_ROUTE_MANIFEST } from "@repo/ai/media/catalog/dispatch-manifest";

import { parseMediaQueueLimits, providerQueueKey, QUEUE_NAMES } from "../queues";
import type { TaskDefinition, TaskRequest } from "./contracts";

type Parser<T> = (value: unknown) => T;

function invalid(): never {
	throw new Error("INVALID_TASK_REQUEST");
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return invalid();
	return value as Record<string, unknown>;
}

function text(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.length > 2_048 || value.includes("\0")) {
		return invalid();
	}
	return value;
}

function integer(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return invalid();
	return value;
}

function timestamp(value: unknown): number {
	const result = integer(value);
	if (!Number.isFinite(new Date(result).getTime())) return invalid();
	return result;
}

function boolean(value: unknown): boolean {
	if (typeof value !== "boolean") return invalid();
	return value;
}

function optional<T>(parser: Parser<T>): Parser<T | undefined> {
	return (value) => (value === undefined ? undefined : parser(value));
}

function strictObject<S extends Record<string, Parser<unknown>>>(
	shape: S,
): Parser<{ [K in keyof S]: ReturnType<S[K]> }> {
	return (value) => {
		const input = record(value);
		if (Object.keys(input).some((key) => !Object.hasOwn(shape, key))) return invalid();
		const result: Record<string, unknown> = {};
		for (const [key, parser] of Object.entries(shape)) {
			const parsed = parser(input[key]);
			if (parsed !== undefined) result[key] = parsed;
		}
		// Each field has passed the corresponding parser above; omitted fields are optional.
		return result as { [K in keyof S]: ReturnType<S[K]> };
	};
}

function objectKeys(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > 100) return invalid();
	return value.map(text);
}

function reservationStatus(value: unknown): "EXPIRED" | "RELEASED" {
	if (value !== "EXPIRED" && value !== "RELEASED") return invalid();
	return value;
}

const job = { jobId: text, version: integer };
const cleanup = {
	assetId: text,
	objectKey: text,
	cleanupObjectKeys: optional(objectKeys),
	uploadSessionId: optional(text),
	reservationStatus: optional(reservationStatus),
	storageReservationReferenceKey: optional(text),
};
const scheduled = strictObject({ timestamp: optional(timestamp) });
const dispatchPayload = strictObject({
	...job,
	provider: optional(text),
	providerModelId: optional(text),
});

const payloadParsers = {
	"media-deliver-outbox": scheduled,
	"media-admit-guest-generation": strictObject({ jobId: text, trialId: text }),
	"media-cancel-generation": strictObject(job),
	"media-finalize-generation": strictObject(job),
	"media-settle-generation": strictObject(job),
	"media-process-payment-event": strictObject({ paymentEventId: text }),
	"media-process-provider-webhook": strictObject({ providerWebhookEventId: text }),
	"media-poll-generation": strictObject({ attemptId: text }),
	"media-verify-upload": strictObject({
		assetId: text,
		allowQuarantinedReverification: optional(boolean),
	}),
	"media-delete-object": strictObject(cleanup),
	"media-abort-multipart": strictObject({ ...cleanup, multipartUploadId: text }),
	"media-cleanup-upload-promotion": strictObject({
		...cleanup,
		multipartUploadId: optional(text),
		promotionObjectKey: text,
		promotionMultipartUploadId: optional(text),
	}),
	"media-abort-promotion-multipart": strictObject({
		assetId: text,
		objectKey: text,
		multipartUploadId: text,
		promotionAbortOnly: optional((value) => (value === true ? true : invalid())),
	}),
	"media-expire-guest-media": scheduled,
	"media-expire-uploads": scheduled,
	"media-grant-billing-periods": scheduled,
	"media-reconcile-generations": scheduled,
	"media-reconcile-subscriptions": scheduled,
	"media-recover-finalizing-generations": scheduled,
	"media-recover-verifications": scheduled,
	"media-recover-payment-events": scheduled,
	"media-reconcile-subscriptions-continuation": strictObject({
		sweepId: text,
		continuationKey: text,
		sequence: integer,
	}),
};

export function parseTaskPayload<T extends keyof typeof payloadParsers>(
	taskId: T,
	payload: unknown,
): ReturnType<(typeof payloadParsers)[T]> {
	const parsed = payloadParsers[taskId](payload);
	if (
		["media-delete-object", "media-abort-multipart", "media-cleanup-upload-promotion"].includes(
			taskId,
		)
	) {
		const fields: Record<string, unknown> = parsed;
		if (
			fields.storageReservationReferenceKey !== undefined &&
			fields.storageReservationReferenceKey !== `generation-output:${text(fields.assetId)}`
		)
			return invalid();
		if (Boolean(fields.uploadSessionId) !== Boolean(fields.reservationStatus)) return invalid();
	}
	return parsed as ReturnType<(typeof payloadParsers)[T]>;
}

export function dispatchRouteForTask(taskId: string) {
	return STATIC_DISPATCH_ROUTE_MANIFEST.find((route) => route.taskId === taskId);
}

export function parseDispatchPayload(taskId: string, payload: unknown) {
	const route = dispatchRouteForTask(taskId);
	if (!route) return invalid();
	const parsed = dispatchPayload(payload);
	if (
		(parsed.provider !== undefined && parsed.provider !== route.provider) ||
		(parsed.providerModelId !== undefined && parsed.providerModelId !== route.providerModelId)
	)
		return invalid();
	return { ...parsed, provider: route.provider, providerModelId: route.providerModelId };
}

export function parseTaskRequest(value: unknown): TaskRequest {
	const envelope = strictObject({ taskId: text, payload: record })(value);
	if (dispatchRouteForTask(envelope.taskId)) {
		parseDispatchPayload(envelope.taskId, envelope.payload);
		return { taskId: envelope.taskId, payload: dispatchPayload(envelope.payload) };
	}
	if (!Object.hasOwn(payloadParsers, envelope.taskId)) return invalid();
	return {
		taskId: envelope.taskId,
		payload: parseTaskPayload(envelope.taskId as keyof typeof payloadParsers, envelope.payload),
	};
}

const definitions: Record<keyof typeof payloadParsers, TaskDefinition> = {
	"media-deliver-outbox": definition("media-outbox", 2, 120),
	"media-admit-guest-generation": definition("media-guest-admission", 1, 60, 1),
	"media-cancel-generation": definition("media-provider-cancellation", 4, 60, 5),
	"media-finalize-generation": definition(QUEUE_NAMES.finalization, 3, 900, 5),
	"media-settle-generation": definition(QUEUE_NAMES.settlementRecovery, 2, 60, 8),
	"media-process-payment-event": definition("media-payment-events", 5, 60, 8),
	"media-process-provider-webhook": definition("media-provider-events", 10, 60, 5),
	"media-poll-generation": definition("media-generation-polling", 8, 300, 3),
	"media-verify-upload": definition("media-upload-verification", 5, 120, 8),
	"media-delete-object": definition("media-storage-cleanup", 4, 120),
	"media-abort-multipart": definition("media-storage-cleanup", 4, 120),
	"media-cleanup-upload-promotion": definition("media-storage-cleanup", 4, 120),
	"media-abort-promotion-multipart": definition("media-storage-cleanup", 4, 120),
	"media-expire-guest-media": definition("media-guest-retention", 1, 120),
	"media-expire-uploads": definition("media-upload-maintenance", 1, 120),
	"media-grant-billing-periods": definition("media-billing-periods", 1, 120),
	"media-reconcile-generations": definition("media-reconciliation", 1, 240),
	"media-reconcile-subscriptions": definition("media-subscription-reconciliation", 1, 120, 5),
	"media-reconcile-subscriptions-continuation": definition(
		"media-subscription-reconciliation",
		1,
		120,
		5,
	),
	"media-recover-finalizing-generations": definition("media-finalization-recovery", 1, 120),
	"media-recover-verifications": definition("media-verification-recovery", 1, 120),
	"media-recover-payment-events": definition("media-payment-recovery", 1, 120),
};

function definition(
	queue: string,
	concurrency: number,
	timeoutSeconds: number,
	maxAttempts = 3,
): TaskDefinition {
	return { queue, concurrency, timeoutSeconds, maxAttempts };
}

export function taskDefinition(
	taskId: string,
	environment: Record<string, string | undefined> = {},
): TaskDefinition {
	const limits = parseMediaQueueLimits(environment);
	const route = dispatchRouteForTask(taskId);
	if (route) {
		const concurrency =
			limits.models[providerQueueKey(route.provider, route.providerModelId)] ??
			limits.providers[route.provider] ??
			(route.mediaKind === "image" ? limits.imageSubmission : limits.videoSubmission);
		const maxAttempts =
			route.provider === "openrouter" || (route.provider === "kie" && route.mediaKind === "image")
				? 1
				: 5;
		return definition(
			route.queueName,
			concurrency,
			route.provider === "openrouter" ? 300 : 60,
			maxAttempts,
		);
	}
	if (!Object.hasOwn(definitions, taskId)) return invalid();
	const value = { ...definitions[taskId as keyof typeof definitions] };
	if (taskId === "media-finalize-generation") value.concurrency = limits.finalization;
	if (taskId === "media-settle-generation") value.concurrency = limits.settlementRecovery;
	return value;
}

export function maintenanceTasksAt(value: number): string[] {
	const minute = new Date(timestamp(value)).getUTCMinutes();
	const tasks = [
		"media-deliver-outbox",
		"media-recover-finalizing-generations",
		"media-recover-verifications",
		"media-recover-payment-events",
	];
	if (minute % 5 === 0) tasks.push("media-reconcile-generations", "media-expire-guest-media");
	if (minute % 15 === 0) tasks.push("media-expire-uploads");
	if (minute === 5) tasks.push("media-grant-billing-periods");
	if (minute === 15) tasks.push("media-reconcile-subscriptions");
	return tasks;
}
