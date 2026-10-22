import type { MediaSafetyAdapter, ModerationDecision } from "@repo/ai/media/moderation/types";
import { createConfiguredVideoSafetyAdapter } from "@repo/ai/media/moderation/video-configured";
import {
	buildKieSeedanceReferenceRequest,
	KieSeedanceReferenceAdapter,
	type KieSeedanceReferenceInput,
} from "@repo/ai/media/providers/kie-seedance-reference";
import {
	buildKieVideoModelRequest,
	KieVideoModelsAdapter,
	resolveKieVideoModelId,
	type KieVideoModelInput,
	type KieVideoResultContext,
} from "@repo/ai/media/providers/kie-video-models";
import {
	buildKieVideoV1Request,
	KieVideoV1Adapter,
	type KieVideoV1Input,
	type KieVideoV1Result,
	type KieVideoV1Submission,
} from "@repo/ai/media/providers/kie-video-v1";
import { VIDEO_VEO_TIER_CONTRACT_VERSION } from "@repo/config/video-models";
import { readVideoSeeapiCallbackConfig } from "@repo/config/video-seeapi-callback";
import {
	isApprovedVideoTextDecision,
	readVideoTextSafetyProfile,
	videoTextSafetyProfilesMatch,
} from "@repo/config/video-text-safety";
import {
	readVideoV1Config,
	resolveVideoV1CallbackBaseUrl,
	VIDEO_V1_RULE_VERSION,
} from "@repo/config/video-v1";
import { getVideoEffectiveInputSnapshot } from "@repo/database/video-template-execution";
import * as database from "@repo/database/video-v1-execution";
import { createSignedReadUrl } from "@repo/storage";

import type {
	ProviderResult,
	ReviewStepResult,
	SubmissionStepResult,
	VideoInputSnapshot,
} from "./contracts";
import { createSeeapiVideoInputCallbackUrl } from "./seeapi-callback-url";
import { requireVideoTemplateRuntimeEnabled } from "./template-runtime-gates";
import { moderateVideoText } from "./text-moderation";

const object = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
type Store = Pick<
	typeof database,
	| "getVideoExecutionContext"
	| "getVideoInputReviewContext"
	| "assertVideoInputIdentity"
	| "recordVideoInputReview"
	| "claimVideoImageReview"
	| "claimVideoProviderSubmission"
	| "recordVideoSubmissionAccepted"
	| "markVideoSubmissionUncertain"
	| "failVideoExecution"
	| "recordVideoProviderSuccess"
	| "recordVideoProviderAccounting"
	| "consumeVideoProviderEvents"
>;
export interface VideoSubmissionDependencies {
	store: Store;
	safety: MediaSafetyAdapter;
	moderateText: MediaSafetyAdapter["moderateText"];
	provider: {
		submit(
			input: KieVideoV1Input | KieVideoModelInput | KieSeedanceReferenceInput,
		): Promise<KieVideoV1Submission>;
		retrieve(
			taskId: string,
			productKey?: string,
			context?: KieVideoResultContext,
		): Promise<KieVideoV1Result>;
	};
	signRead: (objectKey: string) => Promise<string>;
	env: Record<string, string | undefined>;
	now: () => Date;
}

function dependencies(
	overrides?: Partial<VideoSubmissionDependencies>,
): VideoSubmissionDependencies {
	const env = overrides?.env ?? process.env;
	const legacyProvider = new KieVideoV1Adapter({ apiKey: env.KIE_API_KEY ?? "" });
	const modelProvider = new KieVideoModelsAdapter({ apiKey: env.KIE_API_KEY ?? "" });
	const referenceProvider = new KieSeedanceReferenceAdapter({ apiKey: env.KIE_API_KEY ?? "" });
	return {
		store: database,
		safety: createConfiguredVideoSafetyAdapter(env),
		moderateText: (input) => moderateVideoText(input, env),
		provider: {
			submit: (input) =>
				"referenceVideoUrls" in input
					? referenceProvider.submit(input)
					: "productKey" in input
						? modelProvider.submit(input)
						: legacyProvider.submit(input),
			retrieve: (taskId, productKey, context) =>
				productKey
					? modelProvider.retrieve(taskId, productKey, context)
					: legacyProvider.retrieve(taskId),
		},
		signRead: (objectKey) =>
			createSignedReadUrl({ bucket: "media", key: objectKey, expiresIn: 3600 }),
		env,
		now: () => new Date(),
		...overrides,
	};
}

/** Rebuild only server-owned, persisted input; transient signed URLs never enter its fingerprint. */
function prepareVideoProviderRequest(
	snapshot: VideoInputSnapshot,
	callbackUrl: string,
	imageUrl?: string,
	motionUrl?: string,
) {
	if (
		"veoTier" in snapshot &&
		snapshot.veoTier !== undefined &&
		(snapshot.productKey !== "video-veo-3-1" ||
			snapshot.modelContractVersion !== VIDEO_VEO_TIER_CONTRACT_VERSION)
	)
		throw new Error("VIDEO_MODEL_CONTRACT_UNAVAILABLE");
	if (snapshot.mode === "image-to-video" && !snapshot.inputIdentity)
		throw new Error("VIDEO_INPUT_IDENTITY_MISSING");
	const common = {
		prompt: snapshot.prompt,
		duration: snapshot.duration,
		sound: snapshot.sound,
		callbackUrl,
	};
	const template = snapshot.videoEffectTemplate;
	if (template?.schemaVersion === 2 && template.executionKind === "seedance-reference") {
		if (!imageUrl || !motionUrl || template.video.productKey !== "video-seedance-2")
			throw new Error("VIDEO_REFERENCE_INPUT_IDENTITY_MISSING");
		const input: KieSeedanceReferenceInput = {
			...common,
			productKey: "video-seedance-2",
			duration: 5,
			resolution: "720p",
			aspectRatio: "9:16",
			sound: false,
			referenceImageUrls: [imageUrl],
			referenceVideoUrls: [motionUrl],
		};
		const request = buildKieSeedanceReferenceRequest(input);
		return { input, providerModelId: request.model, productKey: input.productKey };
	}
	if ("productKey" in snapshot) {
		const input: KieVideoModelInput = {
			...common,
			productKey: snapshot.productKey,
			mode: snapshot.mode,
			resolution: snapshot.resolution,
			aspectRatio: snapshot.aspectRatio,
			...(snapshot.veoTier !== undefined ? { veoTier: snapshot.veoTier } : {}),
			...(snapshot.inputAssetId !== undefined ? { inputAssetId: snapshot.inputAssetId } : {}),
			...(snapshot.mode === "image-to-video" ? { imageUrl } : {}),
			...(snapshot.videoEffectTemplate?.video.fixedLens
				? { templateFixedLens: true as const }
				: {}),
		};
		if (
			snapshot.mode === "image-to-video" &&
			snapshot.inputIdentity?.assetId !== snapshot.inputAssetId
		)
			throw new Error("VIDEO_INPUT_IDENTITY_CHANGED");
		const request = buildKieVideoModelRequest(input);
		return { input, providerModelId: request.model, productKey: snapshot.productKey };
	}
	const input: KieVideoV1Input =
		snapshot.mode === "text-to-video"
			? {
					...common,
					duration: snapshot.duration,
					sound: snapshot.sound,
					mode: "text-to-video",
					aspectRatio: snapshot.aspectRatio,
				}
			: {
					...common,
					duration: snapshot.duration,
					sound: snapshot.sound,
					mode: "image-to-video",
					imageUrl: imageUrl!,
				};
	const request = buildKieVideoV1Request(input);
	return { input, providerModelId: request.model, productKey: undefined };
}

export async function hashVideoCallbackToken(token: string): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readDecision(value: unknown): ModerationDecision | null {
	const entry = object(value);
	return ["ALLOW", "REJECT", "REVIEW", "ERROR"].includes(String(entry.decision))
		? (entry as unknown as ModerationDecision)
		: null;
}

export async function reviewVideoInput(
	jobId: string,
	overrides?: Partial<VideoSubmissionDependencies>,
): Promise<ReviewStepResult> {
	const deps = dependencies(overrides);
	const job = await deps.store.getVideoInputReviewContext(jobId);
	if (!job?.videoExecution) throw new Error("VIDEO_JOB_NOT_FOUND");
	if (job.videoExecution.stage === "NEEDS_REVIEW")
		return { status: "ERROR", reasonCode: "VIDEO_OPERATOR_REVIEW_REQUIRED", retryable: false };
	if (job.attempts.length) return { status: "ALLOW" }; // Already submitted only after durable approval.
	if (["FAILED", "REJECTED"].includes(job.videoExecution.stage))
		return { status: "REJECT", reasonCode: job.failureCode ?? "VIDEO_INPUT_REJECTED" };
	try {
		deps.store.assertVideoInputIdentity(job);
	} catch {
		await deps.store.failVideoExecution(jobId, "VIDEO_INPUT_IDENTITY_CHANGED", true);
		return { status: "REJECT", reasonCode: "VIDEO_INPUT_IDENTITY_CHANGED" };
	}
	const snapshot = (object(job.inputSnapshot).videoEffectTemplate
		? getVideoEffectiveInputSnapshot(job)
		: job.inputSnapshot) as unknown as VideoInputSnapshot;
	let textSafetyProfile;
	try {
		textSafetyProfile = readVideoTextSafetyProfile(snapshot);
	} catch {
		return { status: "ERROR", reasonCode: "VIDEO_TEXT_SAFETY_PROFILE_INVALID", retryable: false };
	}
	const review = object(object(job.videoExecution.stageData).inputReview);
	const matchesTextProfile =
		videoTextSafetyProfilesMatch(review.textSafetyProfile, textSafetyProfile) &&
		review.requestFingerprint === snapshot.requestFingerprint;
	const reviewUnexpired =
		typeof review.validUntil === "string" && new Date(review.validUntil) > deps.now();
	if (
		review.status === "ALLOW" &&
		review.ruleVersion === VIDEO_V1_RULE_VERSION &&
		matchesTextProfile &&
		isApprovedVideoTextDecision(review.textDecision, textSafetyProfile) &&
		(snapshot.mode !== "image-to-video" ||
			readDecision(review.imageDecision)?.decision === "ALLOW") &&
		review.requestFingerprint === snapshot.requestFingerprint &&
		reviewUnexpired
	)
		return { status: "ALLOW" };
	// A new text decision cannot renew the frozen visual approval. Keep this
	// unsent input held until a complete new visual review can be authorized.
	if (snapshot.mode === "image-to-video" && review.status === "ALLOW")
		return { status: "ERROR", reasonCode: "VIDEO_INPUT_REVIEW_REQUIRED", retryable: false };
	const startedAt = job.videoExecution.inputReviewStartedAt ?? deps.now();
	const config = readVideoV1Config(deps.env);
	const deadlineAt = new Date(
		startedAt.getTime() + config.moderationDeadlineSeconds * 1000,
	).toISOString();
	const metadata = {
		ruleVersion: VIDEO_V1_RULE_VERSION,
		requestFingerprint: snapshot.requestFingerprint,
		textSafetyProfile,
	};
	let text =
		matchesTextProfile && (review.status !== "ALLOW" || reviewUnexpired)
			? readDecision(review.textDecision)
			: null;
	if (text?.ruleVersion !== textSafetyProfile.ruleVersion) text = null;
	// A known rejection or invalid cached approval never starts a new paid image review.
	if (text?.decision === "REJECT" || text?.decision === "REVIEW") {
		await deps.store.failVideoExecution(jobId, text.reasonCode, true);
		return { status: "REJECT", reasonCode: text.reasonCode };
	}
	if (text?.decision === "ALLOW" && !isApprovedVideoTextDecision(text, textSafetyProfile))
		return { status: "ERROR", reasonCode: "VIDEO_TEXT_REVIEW_INVALID", retryable: false };
	const identity = snapshot.mode === "image-to-video" ? snapshot.inputIdentity : null;
	if (snapshot.mode === "image-to-video" && !identity)
		throw new Error("VIDEO_INPUT_IDENTITY_MISSING");
	const cachedImage = identity ? readDecision(review.imageDecision) : null;
	const needsImage =
		!!identity &&
		(!cachedImage ||
			cachedImage.decision === "ERROR" ||
			(cachedImage.decision === "REVIEW" && cachedImage.reasonCode === "IMAGE_PROCESSING"));
	let taskId = typeof review.imageTaskId === "string" ? review.imageTaskId : null;
	let callbackUrl: string | undefined;
	let preparedAssetUrl: string | undefined;
	const uncertainImage: ReviewStepResult = {
		status: "ERROR",
		reasonCode: "VIDEO_IMAGE_REVIEW_SUBMISSION_UNCERTAIN",
		retryable: false,
	};
	if (needsImage && deps.safety.submitImage && deps.safety.retrieveImage && !taskId) {
		if (review.imageSubmissionUncertain) return uncertainImage;
		preparedAssetUrl = await deps.signRead(identity!.objectKey);
		const callbackToken = readVideoSeeapiCallbackConfig(deps.env).ready
			? crypto.randomUUID()
			: undefined;
		if (callbackToken)
			callbackUrl = await createSeeapiVideoInputCallbackUrl(
				{ jobId, assetId: identity!.assetId, submissionToken: callbackToken },
				deps.env,
			);
		// One transaction binds frozen metadata, callback identity and the may-have-sent
		// fence before either independent external review is started.
		if (
			!(await deps.store.claimVideoImageReview(jobId, {
				...metadata,
				...(callbackToken ? { callbackToken } : {}),
			}))
		)
			return uncertainImage;
	} else if (!matchesTextProfile || review.ruleVersion !== VIDEO_V1_RULE_VERSION) {
		await deps.store.recordVideoInputReview(jobId, metadata);
	}
	let imageError: ReviewStepResult | undefined;
	const decisions = await Promise.allSettled([
		(async () =>
			!text || text.decision === "ERROR"
				? deps.moderateText({ text: snapshot.prompt, ruleVersion: textSafetyProfile.ruleVersion })
				: text)(),
		(async () => {
			if (!needsImage || !identity) return cachedImage;
			const assetUrl = preparedAssetUrl ?? (await deps.signRead(identity.objectKey));
			if (!deps.safety.submitImage || !deps.safety.retrieveImage)
				return deps.safety.moderateImage({ assetUrl, ruleVersion: VIDEO_V1_RULE_VERSION });
			let image: ModerationDecision | null = null;
			if (!taskId) {
				let submission;
				try {
					submission = await deps.safety.submitImage({
						assetUrl,
						ruleVersion: VIDEO_V1_RULE_VERSION,
						idempotencyKey: `video-input:${jobId}:${identity.checksum}`,
						...(callbackUrl ? { callbackUrl } : {}),
					});
				} catch {
					imageError = uncertainImage;
					return null;
				}
				taskId = submission.moderationTaskId;
				await deps.store.recordVideoInputReview(jobId, {
					imageTaskId: taskId,
					imageSubmissionUncertain: false,
				});
				image = submission.completedDecision ?? null;
			}
			// Keep immediate terminal evidence and a single immediate read for existing
			// pending providers. Signed callbacks interrupt the fallback Workflow wait.
			return (
				image ??
				deps.safety.retrieveImage({
					assetUrl,
					moderationTaskId: taskId,
					ruleVersion: VIDEO_V1_RULE_VERSION,
				})
			);
		})(),
	]);
	const [textResult, imageResult] = decisions;
	text = textResult.status === "fulfilled" ? textResult.value : null;
	const image = imageResult.status === "fulfilled" ? imageResult.value : null;
	const patch: Record<string, unknown> = {
		...(text ? { textDecision: text } : {}),
		...(image ? { imageDecision: image } : {}),
	};
	// A thrown branch cannot abandon its sibling's finished evidence or erase the
	// image send fence. Persist successful work before surfacing the original error.
	if (textResult.status === "rejected" || imageResult.status === "rejected") {
		if (Object.keys(patch).length) await deps.store.recordVideoInputReview(jobId, patch);
		throw textResult.status === "rejected"
			? textResult.reason
			: (imageResult as PromiseRejectedResult).reason;
	}
	let result: ReviewStepResult;
	if (text!.decision === "REJECT" || text!.decision === "REVIEW")
		result = { status: "REJECT", reasonCode: text!.reasonCode };
	else if (text!.decision !== "ALLOW")
		result = { status: "ERROR", reasonCode: text!.reasonCode, retryable: false };
	else if (!isApprovedVideoTextDecision(text, textSafetyProfile))
		result = { status: "ERROR", reasonCode: "VIDEO_TEXT_REVIEW_INVALID", retryable: false };
	else if (imageError) result = imageError;
	else if (image?.decision === "REVIEW" && image.reasonCode === "IMAGE_PROCESSING")
		result = { status: "PENDING", retryAfterSeconds: config.moderationPollSeconds, deadlineAt };
	else if (image?.decision === "REJECT" || image?.decision === "REVIEW")
		result = { status: "REJECT", reasonCode: image.reasonCode };
	else if (image && image.decision !== "ALLOW")
		result = { status: "ERROR", reasonCode: image.reasonCode, retryable: false };
	else result = { status: "ALLOW" };
	await deps.store.recordVideoInputReview(jobId, {
		...patch,
		...(result.status === "ALLOW"
			? {
					status: "ALLOW",
					...metadata,
					validUntil: new Date(deps.now().getTime() + 3600_000).toISOString(),
				}
			: {}),
	});
	if (result.status === "REJECT")
		await deps.store.failVideoExecution(jobId, result.reasonCode, true);
	return result;
}

export async function submitVideoAttempt(
	jobId: string,
	overrides?: Partial<VideoSubmissionDependencies>,
): Promise<SubmissionStepResult> {
	const deps = dependencies(overrides);
	const job = await deps.store.getVideoExecutionContext(jobId);
	if (!job?.videoExecution) throw new Error("VIDEO_JOB_NOT_FOUND");
	const existing = job.attempts[0];
	if (existing) return replaySubmission(existing);
	const snapshot = (object(job.inputSnapshot).videoEffectTemplate
		? getVideoEffectiveInputSnapshot(job)
		: job.inputSnapshot) as unknown as VideoInputSnapshot;
	readVideoTextSafetyProfile(snapshot);
	// Finish all deterministic preparation before creating the irrevocable send fence.
	const callbackBase = resolveVideoV1CallbackBaseUrl(deps.env);
	if (!callbackBase || !deps.env.KIE_WEBHOOK_SECRET)
		throw new Error("VIDEO_CALLBACK_CONFIGURATION_INVALID");
	const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	const callbackUrl = new URL(`/api/webhooks/video/kie/${token}`, callbackBase).href;
	const imageUrl =
		snapshot.mode === "image-to-video" && snapshot.inputIdentity
			? await deps.signRead(snapshot.inputIdentity.objectKey)
			: undefined;
	const reference =
		snapshot.videoEffectTemplate?.schemaVersion === 2 &&
		snapshot.videoEffectTemplate.executionKind === "seedance-reference"
			? snapshot.videoEffectTemplate.approvedMotionReference
			: undefined;
	// Only the immutable backend-approved private key is signed. No user or callback URL is accepted.
	const motionUrl = reference ? await deps.signRead(reference.objectKey) : undefined;
	const prepared = prepareVideoProviderRequest(snapshot, callbackUrl, imageUrl, motionUrl);
	if (snapshot.videoEffectTemplate)
		await requireVideoTemplateRuntimeEnabled(snapshot.videoEffectTemplate, deps.env);
	let claim: Awaited<ReturnType<Store["claimVideoProviderSubmission"]>>;
	try {
		claim = await deps.store.claimVideoProviderSubmission({
			jobId,
			callbackTokenHash: await hashVideoCallbackToken(token),
			providerModelId: prepared.providerModelId,
			ruleVersion: VIDEO_V1_RULE_VERSION,
		});
	} catch (error) {
		const reasonCode = error instanceof Error ? error.message : "";
		if (reasonCode === "VIDEO_INPUT_REVIEW_REQUIRED") {
			// The rejected claim never crossed the send fence. A concurrent caller
			// may have since submitted; that original attempt still takes priority.
			const latest = await deps.store.getVideoExecutionContext(jobId);
			if (latest?.attempts[0]) return replaySubmission(latest.attempts[0]);
			return { status: "INPUT_REVIEW_REQUIRED" };
		}
		if (
			!["VIDEO_PRICE_INVALID", "VIDEO_PRICE_EXPIRED", "VIDEO_FUNDING_POLICY_CHANGED"].includes(
				reasonCode,
			)
		)
			throw error;
		// This rejected claim did not obtain permission to send. A competing caller
		// might have crossed the fence already, so release only under a no-attempt
		// guard in the same locked transaction that terminalizes the job.
		const failed = await deps.store.failVideoExecution(jobId, reasonCode, false, false, {
			onlyBeforeSubmission: true,
		});
		if (failed) return { status: "DEFINITELY_REJECTED", reasonCode };
		const latest = await deps.store.getVideoExecutionContext(jobId);
		if (latest?.attempts[0]) return replaySubmission(latest.attempts[0]);
		if (latest?.status === "FAILED")
			return { status: "DEFINITELY_REJECTED", reasonCode: latest.failureCode ?? reasonCode };
		throw error;
	}
	if ("deferred" in claim) return { status: "DEFERRED", retryAfterMs: claim.retryAfterMs };
	if (!claim.claimed) return replaySubmission(claim.attempt);
	const attemptId = claim.attempt.id;
	try {
		const result = await deps.provider.submit(prepared.input);
		if (result.status === "ACCEPTED") {
			await deps.store.recordVideoSubmissionAccepted(jobId, attemptId, result.providerTaskId);
			return { status: "ACCEPTED", attemptId, providerTaskId: result.providerTaskId };
		}
		if (result.status === "DEFINITELY_REJECTED") {
			const failed = await deps.store.failVideoExecution(jobId, result.reasonCode, false, true);
			if (failed) return { ...result, attemptId };
			// An early signed callback can already have proven acceptance; never refund it here.
			const latest = await deps.store.getVideoExecutionContext(jobId);
			if (latest?.attempts[0]) return replaySubmission(latest.attempts[0]);
		}
		await deps.store.markVideoSubmissionUncertain(jobId, result.reasonCode);
		return { status: "UNCERTAIN", attemptId, reasonCode: result.reasonCode };
	} catch {
		// Even failure to persist taskId after acceptance is uncertain, never permission to resend.
		try {
			await deps.store.markVideoSubmissionUncertain(jobId, "VIDEO_SUBMISSION_UNCONFIRMED");
		} catch {
			/* The pre-send fence remains durable. */
		}
		return { status: "UNCERTAIN", attemptId, reasonCode: "VIDEO_SUBMISSION_UNCONFIRMED" };
	}
}

function replaySubmission(attempt: {
	id: string;
	providerTaskId: string | null;
	status: string;
}): SubmissionStepResult {
	if (attempt.providerTaskId)
		return { status: "ACCEPTED", attemptId: attempt.id, providerTaskId: attempt.providerTaskId };
	if (attempt.status === "FAILED")
		return {
			status: "DEFINITELY_REJECTED",
			attemptId: attempt.id,
			reasonCode: "VIDEO_SUBMISSION_REJECTED",
		};
	return { status: "UNCERTAIN", attemptId: attempt.id, reasonCode: "VIDEO_SUBMISSION_UNCONFIRMED" };
}

export async function confirmVideoProviderResult(
	jobId: string,
	overrides?: Partial<VideoSubmissionDependencies>,
): Promise<ProviderResult> {
	const deps = dependencies(overrides);
	const job = await deps.store.getVideoExecutionContext(jobId);
	if (!job?.videoExecution) throw new Error("VIDEO_JOB_NOT_FOUND");
	const attempt = job.attempts[0];
	if (attempt?.status === "SUCCEEDED") return { status: "SUCCEEDED", attemptId: attempt.id };
	if (["FAILED", "REJECTED"].includes(job.videoExecution.stage))
		return { status: "FAILED", reasonCode: job.failureCode ?? "VIDEO_GENERATION_FAILED" };
	const config = readVideoV1Config(deps.env);
	const deadlineAt = new Date(
		(job.videoExecution.providerSubmitStartedAt ?? job.createdAt).getTime() +
			config.providerDeadlineSeconds * 1000,
	).toISOString();
	if (!attempt?.providerTaskId)
		return { status: "PENDING", retryAfterSeconds: config.providerPollSeconds, deadlineAt };
	const snapshot = job.inputSnapshot as unknown as VideoInputSnapshot;
	// Query routing comes from the immutable request and persisted attempt,
	// never from callback/client fields or an unsigned result URL.
	const productKey = "productKey" in snapshot ? snapshot.productKey : undefined;
	const providerModelId = resolveKieVideoModelId(productKey ?? "video-kling-2-6-v1", snapshot.mode);
	if (attempt.providerModelId !== providerModelId)
		throw new Error("VIDEO_PROVIDER_MODEL_IDENTITY_MISMATCH");
	const queriedAt = deps.now();
	const result = productKey
		? "veoTier" in snapshot && snapshot.veoTier !== undefined
			? await deps.provider.retrieve(attempt.providerTaskId, productKey, {
					resolution: snapshot.resolution,
					veoTier: snapshot.veoTier,
					modelContractVersion: snapshot.modelContractVersion,
				})
			: await deps.provider.retrieve(attempt.providerTaskId, productKey)
		: await deps.provider.retrieve(attempt.providerTaskId);
	if (result.status === "PENDING") {
		await deps.store.consumeVideoProviderEvents(jobId, attempt.id, queriedAt);
		return { status: "PENDING", retryAfterSeconds: config.providerPollSeconds, deadlineAt };
	}
	if (result.status === "FAILED") {
		await deps.store.recordVideoProviderAccounting(
			jobId,
			attempt.id,
			result.providerCreditsConsumed,
		);
		const changed = await deps.store.failVideoExecution(jobId, result.reasonCode);
		await deps.store.consumeVideoProviderEvents(jobId, attempt.id, queriedAt);
		if (!changed) {
			const latest = await deps.store.getVideoExecutionContext(jobId);
			if (latest?.attempts[0]?.status === "SUCCEEDED")
				return { status: "SUCCEEDED", attemptId: latest.attempts[0].id };
		}
		return { status: "FAILED", reasonCode: result.reasonCode };
	}
	await deps.store.recordVideoProviderSuccess({
		jobId,
		attemptId: attempt.id,
		providerTaskId: attempt.providerTaskId,
		outputUrl: result.outputUrl,
		providerCostMicros: result.providerCostMicros,
		providerCreditsConsumed: result.providerCreditsConsumed,
		providerCompletedAt: result.providerCompletedAt,
	});
	await deps.store.consumeVideoProviderEvents(jobId, attempt.id, queriedAt);
	const latest = await deps.store.getVideoExecutionContext(jobId);
	if (latest?.videoExecution && ["FAILED", "REJECTED"].includes(latest.videoExecution.stage))
		return { status: "FAILED", reasonCode: latest.failureCode ?? "VIDEO_GENERATION_FAILED" };
	return { status: "SUCCEEDED", attemptId: attempt.id };
}
