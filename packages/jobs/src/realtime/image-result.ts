import { createHash } from "node:crypto";

import {
	imageResultReceiptSchema,
	isInvalidImageResultMedia,
	isTerminalImageResult,
	type ImageResultReceipt,
} from "@repo/config/image-result";

import { signRequest } from "../orchestration/auth";
import { getMediaJobEventsBinding, mediaJobEventsStub } from "./context";
import { MEDIA_JOB_EVENTS_PATH } from "./contracts";

export function imageResultAssetId(jobId: string, attemptId: string) {
	return `asset_${createHash("sha256").update(`${jobId}:${attemptId}:0`).digest("base64url").slice(0, 32)}`;
}

export async function imageResultRequest(
	jobId: string,
	receipt?: ImageResultReceipt,
): Promise<Response> {
	const binding = getMediaJobEventsBinding();
	const body = JSON.stringify({ type: "image-result", jobId, ...(receipt ? { receipt } : {}) });
	if (binding)
		return mediaJobEventsStub(binding, jobId).fetch(
			new Request("https://media-job-events.internal/image-result", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body,
			}),
		);
	const secret = process.env.WORKFLOWS_DISPATCH_SECRET;
	if (!secret || !process.env.WORKFLOWS_DISPATCH_URL)
		throw new Error("IMAGE_RESULT_TRANSPORT_UNAVAILABLE");
	return fetch(new URL(MEDIA_JOB_EVENTS_PATH, process.env.WORKFLOWS_DISPATCH_URL), {
		method: "POST",
		body,
		headers: await signRequest(secret, "POST", MEDIA_JOB_EVENTS_PATH, body),
		redirect: "manual",
		signal: AbortSignal.timeout(5_000),
	});
}

export async function readImageResult(jobId: string): Promise<ImageResultReceipt | null> {
	const response = await imageResultRequest(jobId);
	if (response.status === 404) return null;
	if (!response.ok) throw new Error("IMAGE_RESULT_UNAVAILABLE");
	const receipt = imageResultReceiptSchema.parse(await response.json());
	if (receipt.context.jobId !== jobId || receipt.context.expiresAt <= Date.now()) return null;
	return receipt;
}

export async function writeImageResult(receipt: ImageResultReceipt): Promise<ImageResultReceipt> {
	const response = await imageResultRequest(receipt.context.jobId, receipt);
	if (!response.ok) throw new Error("IMAGE_RESULT_UNCONFIRMED");
	return imageResultReceiptSchema.parse(await response.json());
}

/** An accepted/terminal task cannot be replaced by a retry or a different candidate. */
export function mergeImageResult(
	previous: ImageResultReceipt | undefined,
	next: ImageResultReceipt,
) {
	if (!previous) return next;
	const convertedRetry =
		isInvalidImageResultMedia(previous) &&
		next.reviewInput === "thumbnail" &&
		next.priorReview?.moderationTaskId === previous.submission.moderationTaskId &&
		next.priorReview.idempotencyKey === previous.submission.idempotency.key;
	const obsoleteDirectRetry =
		previous.reviewInput === "thumbnail" && next.reviewInput === "provider-url";
	if (
		previous.context.jobId !== next.context.jobId ||
		previous.context.ownerId !== next.context.ownerId ||
		previous.context.attemptId !== next.context.attemptId ||
		previous.assetId !== next.assetId ||
		previous.completion.outputUrl !== next.completion.outputUrl ||
		previous.completion.providerTaskId !== next.completion.providerTaskId ||
		previous.context.guest !== next.context.guest ||
		previous.mimeType !== next.mimeType ||
		previous.context.providerModelId !== next.context.providerModelId ||
		previous.policyVersion !== next.policyVersion ||
		(!convertedRetry &&
			!obsoleteDirectRetry &&
			(previous.submission.moderationTaskId !== next.submission.moderationTaskId ||
				previous.submission.idempotency.key !== next.submission.idempotency.key))
	)
		throw new Error("IMAGE_RESULT_CONFLICT");
	if (obsoleteDirectRetry) return previous;
	return isTerminalImageResult(previous) && !convertedRetry
		? previous
		: { ...next, context: previous.context, completion: previous.completion };
}

export function imageResultNotification(receipt: ImageResultReceipt) {
	return {
		jobId: receipt.context.jobId,
		version: `image-result:${receipt.submission.moderationTaskId}`,
		eventId: `mju_${createHash("sha256").update(`image-result:${receipt.assetId}:${receipt.submission.moderationTaskId}`).digest("hex")}`,
	};
}
