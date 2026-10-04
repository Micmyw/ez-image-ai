import type { MediaSafetyAdapter, ModerationDecision } from "@repo/ai/media/moderation/types";
import { createConfiguredVideoSafetyAdapter } from "@repo/ai/media/moderation/video-configured";
import {
	KieTemplateSceneAdapter,
	type KieTemplateSceneInput,
} from "@repo/ai/media/providers/kie-template-scene";
import { parseVideoEffectTemplateSnapshot } from "@repo/config/video-effects.server";
import {
	isApprovedVideoTextDecision,
	readVideoTextSafetyProfile,
} from "@repo/config/video-text-safety";
import {
	readVideoV1Config,
	resolveVideoV1CallbackBaseUrl,
	VIDEO_V1_RULE_VERSION,
} from "@repo/config/video-v1";
import * as templateDatabase from "@repo/database/video-template-execution";
import { recordVideoInputReview } from "@repo/database/video-v1-execution";
import { createSignedReadUrl, storeImmutableVideoTemplateScene } from "@repo/storage";

import type { ReviewStepResult, VideoInputIdentity } from "./contracts";
import { hashVideoCallbackToken } from "./submission";
import { recordVideoStageMetric } from "./telemetry";
import { requireVideoTemplateRuntimeEnabled } from "./template-runtime-gates";
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
type Role = "left" | "right" | "scene";
export interface VideoTemplatePreparationDependencies {
	store: typeof templateDatabase;
	safety: MediaSafetyAdapter;
	moderateText: MediaSafetyAdapter["moderateText"];
	provider: Pick<KieTemplateSceneAdapter, "submit" | "retrieve">;
	signRead(objectKey: string): Promise<string>;
	storeScene: typeof storeImmutableVideoTemplateScene;
	recordInputReview: typeof recordVideoInputReview;
	requireRuntimeEnabled: typeof requireVideoTemplateRuntimeEnabled;
	recordMetric: typeof recordVideoStageMetric;
	env: Record<string, string | undefined>;
	now(): Date;
}

/** One bounded stage advancement per durable call, without any browser-driven continuation.
 * Paid and moderation POSTs are individually fenced in PostgreSQL BEFORE send.
 */
export async function prepareVideoTemplate(
	jobId: string,
	overrides: Partial<VideoTemplatePreparationDependencies> = {},
): Promise<ReviewStepResult> {
	const env = overrides.env ?? process.env;
	const deps: VideoTemplatePreparationDependencies = {
		store: templateDatabase,
		safety: createConfiguredVideoSafetyAdapter(env),
		moderateText: (input) => moderateVideoText(input, env),
		provider: new KieTemplateSceneAdapter({ apiKey: env.KIE_API_KEY ?? "" }),
		signRead: (objectKey) =>
			createSignedReadUrl({ bucket: "media", key: objectKey, expiresIn: 3600 }),
		storeScene: storeImmutableVideoTemplateScene,
		recordInputReview: recordVideoInputReview,
		requireRuntimeEnabled: requireVideoTemplateRuntimeEnabled,
		recordMetric: recordVideoStageMetric,
		env,
		now: () => new Date(),
		...overrides,
	};
	const measured = async <T>(phase: string, operation: () => Promise<T>): Promise<T> => {
		const started = Date.now();
		try {
			return await operation();
		} finally {
			deps.recordMetric({ jobId, stage: `template-${phase}`, durationMs: Date.now() - started });
		}
	};
	let execution = await deps.store.getVideoTemplateExecution(jobId);
	if (!execution) return { status: "ALLOW" }; // Ordinary video keeps its original execution path.
	const template = parseVideoEffectTemplateSnapshot(execution.templateSnapshot);
	const snapshot = object(execution.job.inputSnapshot);
	const textProfile = readVideoTextSafetyProfile(snapshot);
	const config = readVideoV1Config(env);
	const hold = async (reasonCode: string): Promise<ReviewStepResult> => {
		await deps.store.markVideoTemplateNeedsReview(jobId, reasonCode);
		return { status: "ERROR", reasonCode, retryable: false };
	};
	const pending = (startedAt: Date, seconds: number, pollSeconds: number): ReviewStepResult => ({
		status: "PENDING",
		retryAfterSeconds: pollSeconds,
		deadlineAt: new Date(startedAt.getTime() + seconds * 1000).toISOString(),
	});
	if (execution.job.videoExecution?.stage === "NEEDS_REVIEW")
		return { status: "ERROR", reasonCode: "VIDEO_OPERATOR_REVIEW_REQUIRED", retryable: false };
	if (["FAILED", "REJECTED"].includes(execution.job.videoExecution?.stage ?? ""))
		return { status: "REJECT", reasonCode: execution.job.failureCode ?? "VIDEO_TEMPLATE_FAILED" };
	const failedScene = (value: NonNullable<typeof execution>): ReviewStepResult | null => {
		const evidence = object(value.sceneProviderEvidence);
		if (value.sceneState !== "FAILED" && evidence.status !== "FAILED") return null;
		const reason = object(value.stageData).reasonCode ?? evidence.reasonCode;
		return {
			status: "REJECT",
			reasonCode: typeof reason === "string" ? reason : "VIDEO_TEMPLATE_SCENE_FAILED",
		};
	};
	const previousFailure = failedScene(execution);
	if (previousFailure) return previousFailure;
	const inputs = object(execution.inputReview);
	const roleIdentities = execution.orderedRoleIdentities as unknown as Array<
		VideoInputIdentity & { role: "left" | "right" }
	>;
	if (
		roleIdentities.length !== 2 ||
		roleIdentities[0]?.role !== "left" ||
		roleIdentities[1]?.role !== "right"
	)
		return hold("VIDEO_TEMPLATE_ROLE_IDENTITIES_INVALID");
	// DB claim/write helpers revalidate both immutable owner-bound role identities on every transition.
	const reviewImage = async (
		role: Role,
		identity: VideoInputIdentity,
	): Promise<ReviewStepResult> => {
		const fresh = await deps.store.getVideoTemplateExecution(jobId);
		if (!fresh) throw new Error("VIDEO_TEMPLATE_EXECUTION_MISSING");
		const review =
			role === "scene"
				? object(object(fresh.sceneReview).scene)
				: object(object(fresh.inputReview)[role]);
		const reviewStarted =
			role === "scene" ? (fresh.sceneAsset?.finalizedAt ?? fresh.createdAt) : fresh.createdAt;
		if (deps.now().getTime() >= reviewStarted.getTime() + config.moderationDeadlineSeconds * 1000)
			return hold("VIDEO_TEMPLATE_IMAGE_REVIEW_DEADLINE");
		let result = decision(review.decision);
		if (review.checksum !== identity.checksum || review.ruleVersion !== VIDEO_V1_RULE_VERSION)
			result = null;
		if (
			result?.decision === "ALLOW" &&
			(typeof review.validUntil !== "string" ||
				Date.parse(review.validUntil) <= deps.now().getTime())
		)
			return hold("VIDEO_TEMPLATE_IMAGE_REVIEW_EXPIRED");
		if (
			!result ||
			result.decision === "ERROR" ||
			(result.decision === "REVIEW" && result.reasonCode === "IMAGE_PROCESSING")
		) {
			result = null;
			if (!deps.safety.submitImage || !deps.safety.retrieveImage)
				return hold("VIDEO_TEMPLATE_IMAGE_REVIEW_UNAVAILABLE");
			const assetUrl = await deps.signRead(identity.objectKey);
			let taskId = typeof review.taskId === "string" ? review.taskId : null;
			if (!taskId) {
				if (
					review.submissionUncertain ||
					!(await deps.store.claimVideoTemplateImageReview(jobId, role))
				)
					return hold("VIDEO_TEMPLATE_IMAGE_REVIEW_UNCERTAIN");
				try {
					const submitted = await measured(`${role}-review-submit`, () =>
						deps.safety.submitImage!({
							assetUrl,
							ruleVersion: VIDEO_V1_RULE_VERSION,
							idempotencyKey: `video-template:${jobId}:${role}:${identity.checksum}`,
						}),
					);
					taskId = submitted.moderationTaskId;
					result = submitted.completedDecision ?? null;
					await deps.store.recordVideoTemplateImageReview(jobId, role, {
						taskId,
						submissionUncertain: false,
						checksum: identity.checksum,
						ruleVersion: VIDEO_V1_RULE_VERSION,
					});
				} catch {
					return hold("VIDEO_TEMPLATE_IMAGE_REVIEW_UNCERTAIN");
				}
			}
			result ??= await measured(`${role}-review-query`, () =>
				deps.safety.retrieveImage!({
					assetUrl,
					moderationTaskId: taskId!,
					ruleVersion: VIDEO_V1_RULE_VERSION,
				}),
			);
			await deps.store.recordVideoTemplateImageReview(jobId, role, {
				decision: result,
				...identity,
				ruleVersion: VIDEO_V1_RULE_VERSION,
				safetyPolicyVersion: template.safetyPolicyVersion,
				validUntil: new Date(deps.now().getTime() + 3600_000).toISOString(),
			});
		}
		if (result.decision === "REVIEW" && result.reasonCode === "IMAGE_PROCESSING") {
			const started =
				role === "scene" ? (fresh.sceneAsset?.finalizedAt ?? fresh.updatedAt) : fresh.createdAt;
			return pending(started, config.moderationDeadlineSeconds, config.moderationPollSeconds);
		}
		if (result.decision === "REJECT") return { status: "REJECT", reasonCode: result.reasonCode };
		if (result.decision !== "ALLOW") return hold(result.reasonCode);
		return { status: "ALLOW" };
	};
	let sceneText = decision(inputs.sceneTextDecision);
	let motionText = decision(inputs.motionTextDecision);
	if (!execution.resolvedInputIdentity) {
		for (const [key, text] of [
			["sceneTextDecision", template.scene.prompt],
			["motionTextDecision", template.video.prompt],
		] as const) {
			let reviewed = key === "sceneTextDecision" ? sceneText : motionText;
			const promptVersion =
				key === "sceneTextDecision" ? template.scene.promptVersion : template.video.promptVersion;
			const promptHash = await hashVideoCallbackToken(text);
			const evidenceKey = `${key}Identity`;
			const savedIdentity = object(inputs[evidenceKey]);
			if (
				reviewed &&
				(savedIdentity.promptVersion !== promptVersion ||
					savedIdentity.promptHash !== promptHash ||
					savedIdentity.requestFingerprint !== snapshot.requestFingerprint)
			)
				return hold("VIDEO_TEMPLATE_TEXT_REVIEW_IDENTITY_INVALID");
			if (!reviewed) {
				reviewed = await measured(`${key}-review`, () =>
					deps.moderateText({ text, ruleVersion: textProfile.ruleVersion }),
				);
				await deps.store.recordVideoTemplateReview(jobId, "inputs", {
					[key]: reviewed,
					[evidenceKey]: {
						promptVersion,
						promptHash,
						requestFingerprint: snapshot.requestFingerprint,
					},
				});
			}
			if (reviewed.decision === "REJECT")
				return { status: "REJECT", reasonCode: reviewed.reasonCode };
			if (!isApprovedVideoTextDecision(reviewed, textProfile)) return hold(reviewed.reasonCode);
			if (key === "sceneTextDecision") sceneText = reviewed;
			else motionText = reviewed;
		}
		for (const identity of roleIdentities) {
			const reviewed = await reviewImage(identity.role, identity);
			if (reviewed.status !== "ALLOW") return reviewed;
		}
		await deps.store.recordVideoTemplateReview(jobId, "inputs", {
			status: "ALLOW",
			textSafetyProfile: textProfile,
			requestFingerprint: snapshot.requestFingerprint,
		});
		execution = (await deps.store.getVideoTemplateExecution(jobId))!;
		if (!execution.sceneProviderTaskId) {
			if (execution.sceneSubmissionUncertain)
				return hold("VIDEO_TEMPLATE_SCENE_SUBMISSION_UNCERTAIN");
			const callbackBase = resolveVideoV1CallbackBaseUrl(env);
			if (!callbackBase || !env.KIE_WEBHOOK_SECRET)
				return hold("VIDEO_TEMPLATE_CALLBACK_NOT_CONFIGURED");
			const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
				byte.toString(16).padStart(2, "0"),
			).join("");
			const references = await Promise.all(
				roleIdentities.map((identity) => deps.signRead(identity.objectKey)),
			);
			const request: KieTemplateSceneInput = {
				...template.scene,
				referenceUrls: [references[0]!, references[1]!],
				callbackUrl: new URL(`/api/webhooks/video-template/kie/${token}`, callbackBase).href,
			};
			// Strip internal prompt/version/capacity metadata from the provider boundary.
			const providerRequest: KieTemplateSceneInput = {
				productKey: request.productKey,
				prompt: request.prompt,
				referenceUrls: request.referenceUrls,
				aspectRatio: request.aspectRatio,
				outputCount: request.outputCount,
				callbackUrl: request.callbackUrl,
			};
			try {
				await deps.requireRuntimeEnabled(template, env);
			} catch {
				return hold("VIDEO_TEMPLATE_RUNTIME_DISABLED");
			}
			let claim: Awaited<ReturnType<typeof deps.store.claimVideoTemplateSceneSubmission>>;
			try {
				claim = await deps.store.claimVideoTemplateSceneSubmission({
					jobId,
					callbackTokenHash: await hashVideoCallbackToken(token),
				});
			} catch (error) {
				const reason = error instanceof Error ? error.message : "";
				if (
					!["VIDEO_PRICE_EXPIRED", "VIDEO_PRICE_INVALID", "VIDEO_FUNDING_POLICY_CHANGED"].includes(
						reason,
					)
				)
					throw error;
				const latest = await deps.store.getVideoTemplateExecution(jobId);
				if (latest?.submittedAt) return hold("VIDEO_TEMPLATE_SCENE_SUBMISSION_UNCERTAIN");
				// The final fail transaction independently rechecks no uncertain scene/final attempt.
				return { status: "REJECT", reasonCode: reason };
			}
			if (!claim.claimed) {
				if (!claim.execution.sceneProviderTaskId)
					return hold("VIDEO_TEMPLATE_SCENE_SUBMISSION_UNCERTAIN");
			} else {
				try {
					const submitted = await measured("scene-submit", () =>
						deps.provider.submit(providerRequest),
					);
					if (submitted.status === "ACCEPTED")
						await deps.store.recordVideoTemplateSceneAccepted(jobId, submitted.providerTaskId);
					else if (submitted.status === "DEFINITELY_REJECTED") {
						await deps.store.markVideoTemplateSceneFailed(jobId, submitted.reasonCode, true);
						return { status: "REJECT", reasonCode: submitted.reasonCode };
					} else {
						const known = await deps.store.getVideoTemplateExecution(jobId);
						if (!known?.sceneProviderTaskId)
							return hold("VIDEO_TEMPLATE_SCENE_SUBMISSION_UNCERTAIN");
					}
				} catch {
					const known = await deps.store.getVideoTemplateExecution(jobId);
					if (known) {
						const terminal = failedScene(known);
						if (terminal) return terminal;
					}
					if (!known?.sceneProviderTaskId) return hold("VIDEO_TEMPLATE_SCENE_SUBMISSION_UNCERTAIN");
				}
			}
			execution = (await deps.store.getVideoTemplateExecution(jobId))!;
		}
		if (!execution.sceneProviderTaskId) return hold("VIDEO_TEMPLATE_SCENE_SUBMISSION_UNCERTAIN");
		let evidence = object(execution.sceneProviderEvidence);
		if (evidence.status !== "SUCCEEDED") {
			if (
				deps.now().getTime() >=
				(execution.submittedAt ?? execution.createdAt).getTime() +
					config.providerDeadlineSeconds * 1000
			)
				return hold("VIDEO_TEMPLATE_SCENE_PROVIDER_DEADLINE");
			const result = await measured("scene-query", () =>
				deps.provider.retrieve(execution!.sceneProviderTaskId!),
			);
			if (result.status === "PENDING")
				return pending(
					execution.submittedAt ?? execution.createdAt,
					config.providerDeadlineSeconds,
					config.providerPollSeconds,
				);
			await deps.store.recordVideoTemplateSceneProviderResult({
				jobId,
				taskId: execution.sceneProviderTaskId,
				evidence: result,
			});
			if (result.status === "FAILED") {
				await deps.store.markVideoTemplateSceneFailed(jobId, result.reasonCode);
				return { status: "REJECT", reasonCode: result.reasonCode };
			}
			evidence = result;
		}
		if (!execution.sceneAsset?.finalizedAt) {
			let asset: Awaited<ReturnType<typeof deps.store.prepareVideoTemplateSceneAsset>>;
			try {
				asset = await deps.store.prepareVideoTemplateSceneAsset(jobId);
			} catch (error) {
				if (!(error instanceof Error) || error.message !== "VIDEO_TEMPLATE_SCENE_TRANSFER_BUSY")
					throw error;
				const latest = await deps.store.getVideoTemplateExecution(jobId);
				const expiresAt = latest?.sceneAsset?.outputTransferLeaseExpiresAt;
				if (!expiresAt) throw error;
				return {
					status: "PENDING",
					retryAfterSeconds: 5,
					deadlineAt: new Date(expiresAt.getTime() + 60_000).toISOString(),
				};
			}
			if (typeof evidence.outputUrl !== "string")
				throw new Error("VIDEO_TEMPLATE_SCENE_RESULT_MISSING");
			const sourceUrl = evidence.outputUrl;
			const stored = await measured("scene-store", () =>
				deps.storeScene({
					bucket: "media",
					key: asset.objectKey,
					sourceUrl,
					maximumBytes: template.scene.maxOutputBytes,
					allowedHosts: config.outputAllowedHosts,
				}),
			);
			await deps.store.recordVideoTemplateSceneAsset({
				jobId,
				transferToken: asset.outputTransferToken!,
				asset: {
					id: asset.id,
					objectKey: asset.objectKey,
					mimeType: "image/png",
					byteSize: BigInt(stored.bytes),
					checksum: stored.sha256,
					width: stored.width,
					height: stored.height,
					storageEtag: stored.etag,
					storageVersionId: stored.versionId,
				},
			});
		}
		execution = (await deps.store.getVideoTemplateExecution(jobId))!;
		const asset = execution.sceneAsset;
		if (!asset?.checksum || !asset.storageEtag)
			throw new Error("VIDEO_TEMPLATE_SCENE_IDENTITY_MISSING");
		const sceneIdentity: VideoInputIdentity = {
			assetId: asset.id,
			objectKey: asset.objectKey,
			checksum: asset.checksum,
			storageEtag: asset.storageEtag,
			storageVersionId: asset.storageVersionId,
			verificationGeneration: asset.verificationGeneration,
		};
		const reviewed = await reviewImage("scene", sceneIdentity);
		if (reviewed.status !== "ALLOW") return reviewed;
		await deps.store.recordVideoTemplateReview(jobId, "scene", { status: "ALLOW" });
		await deps.store.sealVideoTemplateResolvedInput(jobId);
	}
	// Ordinary provider fence still checks this exact original fingerprint and Waffo profile.
	execution = (await deps.store.getVideoTemplateExecution(jobId))!;
	const resolved = object(execution.resolvedInputIdentity);
	const frozenSceneReview = object(object(resolved.sceneReviewEvidence).scene);
	const sceneAsset = execution.sceneAsset;
	const frozenSceneDecision = decision(frozenSceneReview.decision);
	if (
		!sceneAsset ||
		resolved.assetId !== sceneAsset.id ||
		resolved.checksum !== sceneAsset.checksum ||
		resolved.objectKey !== sceneAsset.objectKey ||
		resolved.storageEtag !== sceneAsset.storageEtag ||
		resolved.storageVersionId !== sceneAsset.storageVersionId ||
		resolved.verificationGeneration !== sceneAsset.verificationGeneration ||
		resolved.parentRequestFingerprint !== snapshot.requestFingerprint ||
		frozenSceneDecision?.decision !== "ALLOW" ||
		frozenSceneReview.checksum !== sceneAsset.checksum ||
		frozenSceneReview.safetyPolicyVersion !== template.safetyPolicyVersion ||
		typeof frozenSceneReview.validUntil !== "string" ||
		!Number.isFinite(Date.parse(frozenSceneReview.validUntil)) ||
		Date.parse(frozenSceneReview.validUntil) <= deps.now().getTime()
	)
		return hold("VIDEO_TEMPLATE_SCENE_REVIEW_EXPIRED_OR_CHANGED");
	motionText = decision(object(execution.inputReview).motionTextDecision);
	if (!motionText || !isApprovedVideoTextDecision(motionText, textProfile))
		return hold("VIDEO_TEMPLATE_TEXT_REVIEW_MISSING");
	await deps.recordInputReview(jobId, {
		status: "ALLOW",
		ruleVersion: VIDEO_V1_RULE_VERSION,
		requestFingerprint: snapshot.requestFingerprint,
		textSafetyProfile: textProfile,
		textDecision: motionText,
		imageDecision: frozenSceneDecision,
		validUntil: frozenSceneReview.validUntil,
	});
	return { status: "ALLOW" };
}
