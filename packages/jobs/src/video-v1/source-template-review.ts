import type { MediaSafetyAdapter, ModerationDecision } from "@repo/ai/media/moderation/types";
import { createConfiguredVideoSafetyAdapter } from "@repo/ai/media/moderation/video-configured";
import {
	isProviderOwnedSourceTemplate,
	createSourceTemplateNoPromptReview,
} from "@repo/config/video-template-execution.server";
import {
	isApprovedVideoTextDecision,
	readVideoTextSafetyProfile,
	videoTextSafetyProfilesMatch,
} from "@repo/config/video-text-safety";
import { readVideoV1Config, VIDEO_V1_RULE_VERSION } from "@repo/config/video-v1";
import * as sourceCallbacks from "@repo/database/video-source-template-events";
import * as database from "@repo/database/video-source-template-review";
import { failVideoExecution } from "@repo/database/video-v1-execution";
import { createSignedReadUrl } from "@repo/storage";
import { preparePrivateImageModeration } from "@repo/storage/lib/image-moderation-input";

import type { ReviewStepResult } from "./contracts";
import {
	createSourceTemplateCallbackUrl,
	newSourceCallbackToken,
	sourceCallbackTokenHash,
} from "./source-template-callback-url";
import { moderateVideoText } from "./text-moderation";

const object = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
const decision = (value: unknown): ModerationDecision | null => {
	const record = object(value);
	return ["ALLOW", "REJECT", "REVIEW", "ERROR"].includes(String(record.decision))
		? (record as unknown as ModerationDecision)
		: null;
};
export interface SourceTemplateReviewDependencies {
	callbacks: Pick<
		typeof sourceCallbacks,
		"claimSourceTemplateCallback" | "finishSourceTemplateCallback"
	>;
	store: typeof database;
	fail: typeof failVideoExecution;
	safety: MediaSafetyAdapter;
	moderateText: MediaSafetyAdapter["moderateText"];
	prepareImageModeration: typeof preparePrivateImageModeration;
	signRead(objectKey: string): Promise<string>;
	env: Record<string, string | undefined>;
	now(): Date;
}

/** Review the frozen source prompt and every uploaded role; never generate a scene. */
export async function reviewSourceTemplateInputs(
	jobId: string,
	overrides: Partial<SourceTemplateReviewDependencies> = {},
): Promise<ReviewStepResult> {
	const env = overrides.env ?? process.env;
	const deps: SourceTemplateReviewDependencies = {
		callbacks: sourceCallbacks,
		store: database,
		fail: failVideoExecution,
		safety: createConfiguredVideoSafetyAdapter(env),
		moderateText: (input) => moderateVideoText(input, env),
		prepareImageModeration: preparePrivateImageModeration,
		signRead: (key) => createSignedReadUrl({ bucket: "media", key, expiresIn: 3600 }),
		env,
		now: () => new Date(),
		...overrides,
	};
	const error = (reasonCode: string): ReviewStepResult => ({
		status: "ERROR",
		reasonCode,
		retryable: false,
	});
	const rejected = async (reasonCode: string): Promise<ReviewStepResult> => {
		await deps.fail(jobId, reasonCode, true);
		return { status: "REJECT", reasonCode };
	};
	const job = await deps.store.getSourceTemplateReviewContext(jobId);
	if (!job?.videoExecution) throw new Error("VIDEO_JOB_NOT_FOUND");
	if (job.videoExecution.stage === "NEEDS_REVIEW") return error("VIDEO_OPERATOR_REVIEW_REQUIRED");
	if (job.attempts.length) return { status: "ALLOW" };
	if (["FAILED", "REJECTED"].includes(job.videoExecution.stage))
		return { status: "REJECT", reasonCode: job.failureCode ?? "VIDEO_INPUT_REJECTED" };
	let identities;
	try {
		identities = deps.store.assertSourceTemplateInputIdentities(job, deps.now());
	} catch {
		return rejected("VIDEO_INPUT_IDENTITY_CHANGED");
	}
	const snapshot = object(job.inputSnapshot);
	const profile = readVideoTextSafetyProfile(snapshot);
	const review = object(object(job.videoExecution.stageData).inputReview);
	const metadata = {
		requestFingerprint: snapshot.requestFingerprint,
		ruleVersion: VIDEO_V1_RULE_VERSION,
		textSafetyProfile: profile,
	};
	if (review.status === "ALLOW") {
		try {
			deps.store.assertSourceTemplateInputReview(snapshot, review, deps.now());
			// Revalidate mutable internal reference authorization even on a cached approval.
			if (!(await deps.store.recordSourceTemplateInputReview(jobId, {})))
				return error("VIDEO_OPERATOR_REVIEW_REQUIRED");
			return { status: "ALLOW" };
		} catch {
			return error("VIDEO_INPUT_REVIEW_REQUIRED");
		}
	}
	const config = readVideoV1Config(env);
	const startedAt = job.videoExecution.inputReviewStartedAt ?? deps.now();
	const deadline = new Date(startedAt.getTime() + config.moderationDeadlineSeconds * 1000);
	if (deps.now() >= deadline) return error("VIDEO_SOURCE_TEMPLATE_REVIEW_DEADLINE");
	// This write checks every current asset/reference before any new external review.
	if (!(await deps.store.recordSourceTemplateInputReview(jobId, metadata)))
		return error("VIDEO_OPERATOR_REVIEW_REQUIRED");
	if (isProviderOwnedSourceTemplate(snapshot)) {
		if (review.textDecision !== undefined) return error("VIDEO_TEXT_REVIEW_INVALID");
		if (
			!(await deps.store.recordSourceTemplateInputReview(jobId, {
				textReviewNotApplicable: createSourceTemplateNoPromptReview(snapshot),
			}))
		)
			return error("VIDEO_OPERATOR_REVIEW_REQUIRED");
	} else {
		const profileMatches =
			review.requestFingerprint === snapshot.requestFingerprint &&
			videoTextSafetyProfilesMatch(review.textSafetyProfile, profile);
		let text = profileMatches ? decision(review.textDecision) : null;
		if (text && text.ruleVersion !== profile.ruleVersion) text = null;
		if (!text || text.decision === "ERROR") {
			text = await deps.moderateText({
				text: String(snapshot.prompt),
				ruleVersion: profile.ruleVersion,
			});
			if (!(await deps.store.recordSourceTemplateInputReview(jobId, { textDecision: text })))
				return error("VIDEO_OPERATOR_REVIEW_REQUIRED");
		}
		if (text.decision === "REJECT" || text.decision === "REVIEW") return rejected(text.reasonCode);
		if (!isApprovedVideoTextDecision(text, profile)) return error("VIDEO_TEXT_REVIEW_INVALID");
	}
	let pending = false;
	for (const identity of identities) {
		const fresh = await deps.store.getSourceTemplateReviewContext(jobId);
		if (!fresh?.videoExecution) throw new Error("VIDEO_JOB_NOT_FOUND");
		if (fresh.videoExecution.stage === "NEEDS_REVIEW")
			return error("VIDEO_OPERATOR_REVIEW_REQUIRED");
		const roles = object(object(object(fresh.videoExecution.stageData).inputReview).roles);
		const saved = object(roles[identity.role]);
		let image = decision(saved.decision);
		if (image?.decision === "ALLOW") {
			if (!deps.store.isApprovedSourceTemplateRoleReview(saved, identity, deps.now()))
				return error("VIDEO_INPUT_REVIEW_REQUIRED");
			continue;
		}
		if (
			image?.decision === "REJECT" ||
			(image?.decision === "REVIEW" && image.reasonCode !== "IMAGE_PROCESSING")
		)
			return rejected(image.reasonCode);
		if (!deps.safety.submitImage || !deps.safety.retrieveImage)
			return error("VIDEO_SOURCE_TEMPLATE_IMAGE_REVIEW_UNAVAILABLE");
		let taskId = typeof saved.taskId === "string" ? saved.taskId : null;
		let assetUrl: string;
		if (!taskId) {
			if (saved.submissionUncertain) return error("VIDEO_IMAGE_REVIEW_SUBMISSION_UNCERTAIN");
			assetUrl =
				deps.safety.imageInputProfile === "seeapi-nsfw-filter-2"
					? await deps.prepareImageModeration(identity)
					: await deps.signRead(identity.objectKey);
			const token = newSourceCallbackToken();
			const callbackUrl = createSourceTemplateCallbackUrl(
				{ provider: "seeapi", token, input: { jobId, role: identity.role } },
				deps.env,
			);
			if (
				!(await deps.store.claimSourceTemplateImageReview(
					jobId,
					identity.role,
					await sourceCallbackTokenHash(token),
				))
			)
				return error("VIDEO_IMAGE_REVIEW_SUBMISSION_UNCERTAIN");
			try {
				const submission = await deps.safety.submitImage({
					callbackUrl,
					assetUrl,
					ruleVersion: VIDEO_V1_RULE_VERSION,
					idempotencyKey: `video-source-template:${jobId}:${identity.role}:${identity.checksum}`,
				});
				taskId = submission.moderationTaskId;
				if (!taskId) return error("VIDEO_IMAGE_REVIEW_SUBMISSION_UNCERTAIN");
				if (
					!(await deps.store.recordSourceTemplateImageReview(jobId, identity.role, {
						taskId,
						submissionUncertain: false,
					}))
				)
					return error("VIDEO_OPERATOR_REVIEW_REQUIRED");
				image = submission.completedDecision ?? null;
			} catch {
				return error("VIDEO_IMAGE_REVIEW_SUBMISSION_UNCERTAIN");
			}
		} else {
			assetUrl = await deps.signRead(identity.objectKey);
			image = null;
		}
		// Only synchronous completion or a persisted callback permits a read. No timer polling.
		let eventId: string | null = null;
		if (!image) {
			try {
				eventId = await deps.callbacks.claimSourceTemplateCallback({
					phase: "input",
					jobId,
					role: identity.role,
				});
			} catch {
				return error("SOURCE_CALLBACK_CONFIRMATION_HELD");
			}
			if (!eventId) {
				pending = true;
				continue;
			}
			try {
				image = await deps.safety.retrieveImage({
					assetUrl,
					moderationTaskId: taskId,
					ruleVersion: VIDEO_V1_RULE_VERSION,
				});
			} catch {
				await deps.callbacks.finishSourceTemplateCallback(eventId, true);
				return error("SOURCE_CALLBACK_CONFIRMATION_FAILED");
			}
		}
		if (
			!(await deps.store.recordSourceTemplateImageReview(jobId, identity.role, { decision: image }))
		)
			return error("VIDEO_OPERATOR_REVIEW_REQUIRED");
		if (eventId)
			await deps.callbacks.finishSourceTemplateCallback(eventId, image.decision === "ERROR");
		if (image.decision === "REVIEW" && image.reasonCode === "IMAGE_PROCESSING") {
			pending = true;
			continue;
		}
		if (image.decision === "REJECT" || image.decision === "REVIEW")
			return rejected(image.reasonCode);
		if (image.decision !== "ALLOW") return error(image.reasonCode);
	}
	if (pending)
		return {
			status: "PENDING",
			waitFor: "callback",
			deadlineAt: deadline.toISOString(),
		};
	try {
		if (
			!(await deps.store.recordSourceTemplateInputReview(jobId, { ...metadata, status: "ALLOW" }))
		)
			return error("VIDEO_OPERATOR_REVIEW_REQUIRED");
	} catch {
		return error("VIDEO_INPUT_REVIEW_REQUIRED");
	}
	return { status: "ALLOW" };
}
