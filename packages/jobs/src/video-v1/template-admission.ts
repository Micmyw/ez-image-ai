import { getImageProductSelectionContract } from "@repo/config";
import {
	readApprovedRumpelstiltskinMotionReference,
	readRumpelstiltskinCostApproval,
} from "@repo/config/rumpelstiltskin-reference.server";
import {
	videoEffectName,
	RUMPELSTILTSKIN_SOLO_EFFECT_ID,
	type VideoEffectId,
	VIDEO_EFFECT_MAX_INPUT_BYTES,
	type VideoEffectRequest,
	type VideoEffectCreateInput,
} from "@repo/config/video-effects";
import { canAccessVideoEffect } from "@repo/config/video-effects-access.server";
import {
	resolveVideoEffectTemplate,
	resolveVideoEffectPrice,
	parseVideoEffectTemplateSnapshot,
} from "@repo/config/video-effects.server";
import { applyVideoInternalFunding } from "@repo/config/video-internal-funding";
import type { VideoV1Bindings } from "@repo/config/video-v1";
import { db } from "@repo/database/client";
import {
	createVideoTemplateQuoteRecord,
	createVideoTemplateJobRecord,
	findExistingVideoTemplateAdmission,
	getVideoTemplateJobRecord,
	listVideoTemplateJobRecords,
} from "@repo/database/video-template";
import type { VideoAdmissionLimits, VideoPrice } from "@repo/database/video-v1";
import { authorizeVideoPlayback } from "@repo/database/video-v1-fulfillment";

import { ensureVideoWorkflowStarted, requireVideoModelReadiness } from "./admission";
import type { VideoOwnerContext, VideoWorkflowBinding } from "./contracts";
import {
	requireVideoTemplateRuntimeEnabled,
	requireVideoTemplateSceneEnvironment,
	VIDEO_TEMPLATE_SCENE_PRODUCT_KEY,
} from "./template-runtime-gates";
import { getVideoWorkflowBinding } from "./workflow-binding";
export { requireVideoTemplateRuntimeEnabled } from "./template-runtime-gates";

export const VIDEO_EFFECT_CAPABILITY_REQUEST: VideoEffectRequest = {
	effectId: "hotel-lobby-duo",
	presetKey: "standard",
	inputs: { leftAssetId: "capability-left", rightAssetId: "capability-right" },
};

/** Client-safe readiness diagnostics. Private manifests and approval data stay here. */
export function readVideoEffectTestReadiness(
	effectId: VideoEffectId,
	environment: Record<string, string | undefined>,
): string[] {
	if (effectId !== RUMPELSTILTSKIN_SOLO_EFFECT_ID) return [];
	const reasons: string[] = [];
	let reference;
	try {
		reference = readApprovedRumpelstiltskinMotionReference(environment);
	} catch {
		reasons.push(
			environment.RUMPELSTILTSKIN_APPROVED_MOTION_REFERENCE
				? "MOTION_REFERENCE_INVALID"
				: "MOTION_REFERENCE_REQUIRED",
		);
	}
	// The dated public budget is bound to the actual reference duration at quotation.
	// Missing material alone does not imply missing public pricing approval.
	if (reference || environment.RUMPELSTILTSKIN_COST_APPROVAL) {
		try {
			readRumpelstiltskinCostApproval(environment, reference);
		} catch {
			reasons.push(
				environment.RUMPELSTILTSKIN_COST_APPROVAL
					? "COST_APPROVAL_INVALID"
					: "COST_APPROVAL_REQUIRED",
			);
		}
	}
	return reasons;
}

export function requireVideoTemplateAdmission(
	context: VideoOwnerContext,
	environment: Record<string, string | undefined>,
	bindings: VideoV1Bindings,
	request: VideoEffectRequest,
) {
	if (
		!canAccessVideoEffect(environment, { id: context.userId, role: context.role }, request.effectId)
	)
		throw new Error("VIDEO_ACCESS_DENIED");
	const template = resolveVideoEffectTemplate(request, environment);
	requireVideoTemplateSceneEnvironment(template, environment);
	const reference = template.schemaVersion === 2 && template.executionKind === "seedance-reference";
	// Reference-video billing differs from first-frame billing. Never use its public list-price quote.
	const referencePrice = reference ? resolveVideoEffectPrice(request, environment) : undefined;
	const admitted = requireVideoModelReadiness(
		environment,
		bindings,
		template.video,
		referencePrice ? { priceOverride: referencePrice } : undefined,
	);
	// An ordinary video administrator budget never authorizes this separate two-stage product.
	const price = applyVideoInternalFunding(
		referencePrice ?? resolveVideoEffectPrice(request, environment),
		context,
		{
			...environment,
			VIDEO_INTERNAL_FUNDING:
				request.effectId === "hotel-lobby-duo"
					? environment.HOTEL_LOBBY_DUO_INTERNAL_FUNDING
					: undefined,
		},
	) satisfies VideoPrice;
	return {
		...admitted,
		template,
		price,
		maximumInputBytes: Math.min(
			VIDEO_EFFECT_MAX_INPUT_BYTES,
			admitted.config.maxInputBytes,
			getImageProductSelectionContract(VIDEO_TEMPLATE_SCENE_PRODUCT_KEY)?.maximumInputBytes ??
				VIDEO_EFFECT_MAX_INPUT_BYTES,
		),
	};
}

export async function createVideoTemplateQuote(
	context: VideoOwnerContext,
	request: VideoEffectRequest,
	options: {
		bindings: VideoV1Bindings;
		maximumInputBytes: number;
		environment?: Record<string, string | undefined>;
	},
) {
	const admitted = requireVideoTemplateAdmission(
		context,
		options.environment ?? process.env,
		options.bindings,
		request,
	);
	await requireVideoTemplateRuntimeEnabled(admitted.template, options.environment ?? process.env);
	const result = await createVideoTemplateQuoteRecord(
		{
			ownerId: context.userId,
			request,
			template: admitted.template,
			price: admitted.price,
			visualSafetyProfile: admitted.visualSafetyProfile,
			textSafetyProfile: admitted.textSafetyProfile,
			audioSafetyPolicy: admitted.audioSafetyPolicy,
			maximumInputBytes: Math.min(admitted.maximumInputBytes, options.maximumInputBytes),
		},
		db,
	);
	return { quoteId: result.quoteId, credits: result.credits, expiresAt: result.expiresAt };
}

export async function createVideoTemplateJob(
	context: VideoOwnerContext,
	input: VideoEffectCreateInput,
	options: {
		bindings: VideoV1Bindings;
		limits: Pick<VideoAdmissionLimits, "maximumStorageBytes" | "maximumInputBytes">;
		environment?: Record<string, string | undefined>;
		binding?: VideoWorkflowBinding;
		requestReceivedAt?: Date;
	},
) {
	// Accepted orders survive a changed price, closed template or expired quote.
	const replay = await findExistingVideoTemplateAdmission(
		{ ownerId: context.userId, ...input },
		db,
	);
	const binding = options.binding ?? getVideoWorkflowBinding();
	if (replay) {
		await ensureVideoWorkflowStarted(replay.id, binding);
		return getVideoTemplatePublicState(context, replay.id);
	}
	const admitted = requireVideoTemplateAdmission(
		context,
		options.environment ?? process.env,
		options.bindings,
		input.request,
	);
	await requireVideoTemplateRuntimeEnabled(admitted.template, options.environment ?? process.env);
	const result = await createVideoTemplateJobRecord(
		{
			ownerId: context.userId,
			...input,
			template: admitted.template,
			price: admitted.price,
			visualSafetyProfile: admitted.visualSafetyProfile,
			textSafetyProfile: admitted.textSafetyProfile,
			audioSafetyPolicy: admitted.audioSafetyPolicy,
			paidFundingPolicy: admitted.price.paidFundingPolicy,
			requestReceivedAt: options.requestReceivedAt,
			limits: {
				...options.limits,
				maximumInputBytes: Math.min(admitted.maximumInputBytes, options.limits.maximumInputBytes),
				ownerConcurrency: admitted.config.ownerConcurrency,
				globalConcurrency: admitted.config.globalConcurrency,
				providerConcurrency: admitted.config.providerConcurrency,
			},
		},
		db,
	);
	await ensureVideoWorkflowStarted(result.jobId, binding);
	return getVideoTemplatePublicState(context, result.jobId);
}

export type VideoTemplatePublicStage =
	| "PREPARING_PHOTOS"
	| "CREATING_SCENE"
	| "GENERATING_VIDEO"
	| "CHECKING_VIDEO"
	| "READY"
	| "NEEDS_REVIEW"
	| "FAILED";
export function videoTemplatePublicStage(
	stage: string,
	sceneState: string,
	uncertain: boolean,
	referenceTemplate = false,
): VideoTemplatePublicStage {
	if (stage === "READY") return "READY";
	if (["REJECTED", "FAILED"].includes(stage)) return "FAILED";
	if (uncertain || ["SUBMISSION_UNCERTAIN", "NEEDS_REVIEW"].includes(stage)) return "NEEDS_REVIEW";
	if (["QUEUED", "INPUT_REVIEW"].includes(stage)) {
		if (referenceTemplate) return "PREPARING_PHOTOS";
		return sceneState === "PENDING" || sceneState === "INPUT_REVIEW"
			? "PREPARING_PHOTOS"
			: "CREATING_SCENE";
	}
	if (["OUTPUT_REVIEW", "FINALIZING", "STORING"].includes(stage)) return "CHECKING_VIDEO";
	return "GENERATING_VIDEO";
}

export async function getVideoTemplatePublicState(
	context: Pick<VideoOwnerContext, "userId">,
	jobId: string,
) {
	const job = await getVideoTemplateJobRecord(context.userId, jobId, db);
	return toVideoTemplatePublicState(context.userId, job);
}
async function toVideoTemplatePublicState(
	ownerId: string,
	job: Awaited<ReturnType<typeof getVideoTemplateJobRecord>>,
) {
	if (!job?.videoTemplateExecution || !job.videoExecution || !job.reservation)
		throw new Error("NOT_FOUND");
	const template = parseVideoEffectTemplateSnapshot(job.videoTemplateExecution.templateSnapshot);
	const stage = videoTemplatePublicStage(
		job.videoExecution.stage,
		job.videoTemplateExecution.sceneState,
		job.videoTemplateExecution.sceneSubmissionUncertain,
		template.schemaVersion === 2 && template.executionKind === "seedance-reference",
	);
	return {
		jobId: job.id,
		effectId: template.effectId,
		name: videoEffectName(template.effectId),
		presetKey: template.presetKey,
		templateVersion: template.templateVersion,
		stage,
		creditState:
			job.reservation.status === "ACTIVE" ? ("RESERVED" as const) : job.reservation.status,
		credits: job.creditsReserved.toString(),
		canPlay:
			stage === "READY" &&
			job.status === "SUCCEEDED" &&
			job.reservation.status === "SETTLED" &&
			Boolean(await authorizeVideoPlayback(ownerId, job.id)),
		failureCode:
			stage === "NEEDS_REVIEW"
				? "REVIEW_REQUIRED"
				: stage === "FAILED"
					? "GENERATION_FAILED"
					: null,
		updatedAt: new Date(
			Math.max(job.updatedAt.getTime(), job.videoTemplateExecution.updatedAt.getTime()),
		).toISOString(),
	};
}

export async function listVideoTemplatePublicStates(
	context: Pick<VideoOwnerContext, "userId">,
	input: { cursor?: string; limit?: number },
) {
	const result = await listVideoTemplateJobRecords(context.userId, input, db);
	return {
		items: await Promise.all(
			result.rows.map((job) => toVideoTemplatePublicState(context.userId, job)),
		),
		nextCursor: result.nextCursor,
	};
}
