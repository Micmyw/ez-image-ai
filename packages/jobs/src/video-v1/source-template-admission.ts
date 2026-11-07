import { resolveSourceTemplateRequest } from "@repo/ai/media/rap-templates/contracts";
import { createVideoAudioSafetyPolicy } from "@repo/config/video-output";
import {
	configuredVideoVisualSafetyProfile,
	configuredProviderOwnedVideoVisualSafetyProfile,
} from "@repo/config/video-safety";
import { VIDEO_SHARED_FUNDING_VERSION } from "@repo/config/video-shared-funding";
import { sourceTemplatePriceKey } from "@repo/config/video-template-display-pricing";
import {
	canonicalSourceTemplateJson,
	decodeSourceTemplatePrice,
	readSourceTemplateInternalRequest,
	sourceTemplateConfigKey,
	sourceTemplateProvisionSchema,
	sourceTemplateInternalRequestSchema,
	sourceTemplatePublicRequestSchema,
	sourceTemplateTransportSchema,
	type SourceTemplatePublicRequest,
	type SourceTemplateInternalRequest,
} from "@repo/config/video-template-execution.server";
import {
	sourceTemplateDefaults,
	sourceTemplateRoles,
	type SourceTemplateChoices,
} from "@repo/config/video-template-library";
import {
	configuredVideoTextSafetyProfile,
	createVideoTextSafetyProfile,
} from "@repo/config/video-text-safety";
import { videoV1Readiness, readVideoV1Config, type VideoV1Bindings } from "@repo/config/video-v1";
import { db } from "@repo/database/client";
import { findApprovedSourceTemplateReferences } from "@repo/database/video-source-template-review";
import {
	createVideoQuoteRecord,
	createVideoJobRecord,
	findExistingVideoAdmission,
	listVideoJobRecords,
	type VideoPrice,
} from "@repo/database/video-v1";
import { authorizeVideoPlaybackSnapshot } from "@repo/database/video-v1-fulfillment";

import { ensureVideoWorkflowStarted, getVideoPublicState, toVideoPublicState } from "./admission";
import type { VideoOwnerContext } from "./contracts";
import { replaceSourceTemplateUrls } from "./source-template-urls";
import { getVideoWorkflowBinding } from "./workflow-binding";
export { replaceSourceTemplateUrls } from "./source-template-urls";

const choiceKeys = new Set([
	"tier",
	"preset",
	"sceneId",
	"stageId",
	"durationSeconds",
	"resolution",
	"aspectRatio",
	"direction",
	"locale",
	"customStage",
	"occasion",
]);
const definiteAdmissionErrors = new Set([
	"QUOTE_EXPIRED",
	"PRICE_CHANGED",
	"INVALID_VIDEO_QUOTE",
	"VIDEO_QUOTE_INPUT_MISMATCH",
	"VIDEO_QUOTE_ALREADY_USED",
	"INSUFFICIENT_CREDITS",
	"CREDIT_DEBT_OUTSTANDING",
	"STORAGE_QUOTA_EXCEEDED",
	"VIDEO_ACCESS_DENIED",
	"VIDEO_DISABLED",
	"MEDIA_GENERATION_DISABLED",
	"VIDEO_TEMPLATE_DISABLED",
	"VIDEO_TEMPLATE_SOURCE_CONFIGURATION_REQUIRED",
	"VIDEO_TEMPLATE_VERSION_CHANGED",
	"VIDEO_TEMPLATE_PRICE_REQUIRED",
	"VIDEO_TEMPLATE_REFERENCE_APPROVAL_REQUIRED",
	"VIDEO_TEMPLATE_OUTPUT_CONTRACT_REQUIRED",
	"VIDEO_TEMPLATE_INPUT_ROLES_INVALID",
	"VIDEO_TEMPLATE_OPTIONS_INVALID",
	"VIDEO_INPUT_NOT_AVAILABLE",
	"ASSET_CONTENT_CHANGED",
	"VIDEO_INPUT_IDENTITY_CHANGED",
	"VIDEO_SOURCE_TEMPLATE_REFERENCE_IDENTITY_CHANGED",
	"VIDEO_SOURCE_TEMPLATE_REFERENCE_APPROVAL_REQUIRED",
	"VIDEO_SOURCE_TEMPLATE_REFERENCE_OWNER_NOT_AUTHORIZED",
	"VIDEO_FUNDING_POLICY_CHANGED",
	"VIDEO_SAFETY_PROFILE_CHANGED",
	"VIDEO_TEXT_SAFETY_PROFILE_CHANGED",
	"VIDEO_AUDIO_SAFETY_POLICY_CHANGED",
	"VIDEO_TEMPLATE_MODERATION_COST_POLICY_REQUIRED",
]);
/** Nominal server-only proof: a known gate/rolled-back admission failed and same-key replay is absent. */
export class SourceTemplateNotAdmittedError extends Error {
	readonly submissionDisposition = "not_admitted" as const;
}
export function normalizeSourceTemplateRequest(
	value: SourceTemplatePublicRequest,
): SourceTemplatePublicRequest {
	const parsed = sourceTemplatePublicRequestSchema.parse(value);
	if (Object.keys(parsed.options).some((key) => !choiceKeys.has(key)))
		throw new Error("VIDEO_TEMPLATE_OPTIONS_INVALID");
	const options = {
		...sourceTemplateDefaults(parsed.templateKey),
		...parsed.options,
	} as SourceTemplateChoices;
	const roles = sourceTemplateRoles(parsed.templateKey, options);
	if (
		roles.length !== parsed.inputs.length ||
		roles.some((role, index) => parsed.inputs[index]?.role !== role) ||
		new Set(parsed.inputs.map((input) => input.assetId)).size !== parsed.inputs.length
	)
		throw new Error("VIDEO_TEMPLATE_INPUT_ROLES_INVALID");
	return { ...parsed, options };
}
export async function loadSourceTemplateProvision(
	templateKey: SourceTemplatePublicRequest["templateKey"],
) {
	const record = await db.runtimeConfigOverride.findFirst({
		where: { configKey: sourceTemplateConfigKey(templateKey), active: true },
		orderBy: { version: "desc" },
	});
	const provision = sourceTemplateProvisionSchema.safeParse(record?.value);
	if (!record || !provision.success)
		throw new Error("VIDEO_TEMPLATE_SOURCE_CONFIGURATION_REQUIRED");
	return { provision: provision.data, receipt: { id: record.id, version: record.version } };
}
export function resolveSourceTemplateAdmission(
	context: VideoOwnerContext,
	input: SourceTemplatePublicRequest,
	environment: Record<string, string | undefined>,
	bindings: VideoV1Bindings,
	configuration: Awaited<ReturnType<typeof loadSourceTemplateProvision>>,
) {
	const request = normalizeSourceTemplateRequest(input);
	const { provision } = configuration;
	if (!provision.enabled) throw new Error("VIDEO_TEMPLATE_DISABLED");
	if (!context.userId || (provision.access === "internal" && context.role !== "admin"))
		throw new Error("VIDEO_ACCESS_DENIED");
	const transport = resolveSourceTemplateRequest({
		templateKey: request.templateKey,
		options: request.options as SourceTemplateChoices,
		userImageUrls: request.inputs.map(
			(input) => `https://ezpic-template.example/user/${input.role}`,
		),
		configs: provision.sourceConfig,
	});
	const refs = transport.requiredAssetUrls.map((sourceUrl) => {
		const matches = provision.references.filter((reference) => reference.sourceUrl === sourceUrl);
		if (matches.length !== 1 || Date.parse(matches[0]!.validUntil) <= Date.now())
			throw new Error("VIDEO_TEMPLATE_REFERENCE_APPROVAL_REQUIRED");
		return matches[0]!;
	});
	const replacements = new Map(
		refs.map((ref, index) => [ref.sourceUrl, `https://ezpic-template.example/reference/${index}`]),
	);
	const frozenTransport = sourceTemplateTransportSchema.parse({
		...transport,
		body: replaceSourceTemplateUrls(transport.body, replacements),
		requiredAssetUrls: transport.requiredAssetUrls.map((url) => replacements.get(url)!),
	});
	const sourceTemplate = {
		templateKey: request.templateKey,
		version: provision.version,
		provision: configuration.receipt,
		request,
		transport: frozenTransport,
		references: refs,
	};
	const internal = sourceTemplateInternalRequestSchema.parse({
		requestKind: "source-template-video",
		sourceTemplate,
		productKey: `source-template:${request.templateKey}`,
		mode: request.inputs.length ? "image-to-video" : "text-to-video",
		prompt: transport.prompt,
		...(request.inputs[0] ? { inputAssetId: request.inputs[0].assetId } : {}),
		duration: transport.output.durationSeconds,
		resolution: transport.output.resolution,
		aspectRatio: transport.output.aspectRatio,
		sound: transport.output.sound,
	});
	const matchingPrices = provision.prices.filter(
		(price) =>
			sourceTemplatePriceKey(price.options as SourceTemplateChoices) ===
			sourceTemplatePriceKey(request.options as SourceTemplateChoices),
	);
	if (matchingPrices.length !== 1) throw new Error("VIDEO_TEMPLATE_PRICE_REQUIRED");
	const configuredPrice = decodeSourceTemplatePrice(provision, matchingPrices[0]!);
	const providerOwned =
		internal.sourceTemplate.transport.executionContract === "provider-owned-template";
	const readiness = videoV1Readiness(environment, bindings, {
		multiModel: true,
		sound: internal.sound,
	});
	// Generation provider/model admission comes from the exact source contract, while shared
	// storage, native Workflow, visual/text review and timing gates stay authoritative.
	const reasons = readiness.reasons.filter(
		(reason) =>
			!["VIDEO_MODEL_CONTRACT_NOT_CONFIRMED", "VIDEO_PROVIDER_NOT_CONFIGURED"].includes(reason) &&
			!(providerOwned && reason === "VIDEO_MODERATION_NOT_CONFIGURED"),
	);
	if (!environment[transport.provider === "seeapi" ? "SEEAPI_API_KEY" : "KIE_API_KEY"]?.trim())
		reasons.push("VIDEO_PROVIDER_NOT_CONFIGURED");
	if (reasons.length) throw new Error(reasons[0]);
	const visualSafetyProfile =
		internal.duration === null
			? configuredProviderOwnedVideoVisualSafetyProfile(environment)
			: configuredVideoVisualSafetyProfile(environment, internal.duration);
	// Keep the versioned compatibility profile; the explicit no-user-prompt evidence
	// is authoritative for this contract and never represents a Waffo decision.
	const textSafetyProfile = providerOwned
		? createVideoTextSafetyProfile()
		: configuredVideoTextSafetyProfile(environment);
	if (
		environment.VIDEO_COST_VISUAL_POLICY_VERSION !== visualSafetyProfile.policyVersion ||
		(!providerOwned && environment.VIDEO_COST_TEXT_RULE_VERSION !== textSafetyProfile.ruleVersion)
	)
		throw new Error("VIDEO_TEMPLATE_MODERATION_COST_POLICY_REQUIRED");
	const price: VideoPrice = {
		credits: BigInt(configuredPrice.credits),
		providerCostMicros: BigInt(configuredPrice.providerCostMicros),
		moderationCostMicros: BigInt(configuredPrice.moderationCostMicros),
		pricingVersion: configuredPrice.pricingVersion,
		pricingBasis: configuredPrice.pricingBasis,
		pricingDetails: {
			paidRevenueQualified: false,
			funding: { mode: VIDEO_SHARED_FUNDING_VERSION },
		},
	};
	return {
		request: internal,
		config: readVideoV1Config(environment),
		visualSafetyProfile,
		textSafetyProfile,
		audioSafetyPolicy: createVideoAudioSafetyPolicy(),
		price,
	};
}

export async function sourceTemplateAccess(
	context: VideoOwnerContext,
	templateKey: SourceTemplatePublicRequest["templateKey"],
	bindings: VideoV1Bindings,
	environment = process.env,
	options: { forUpload?: boolean } = {},
) {
	try {
		const choices = sourceTemplateDefaults(templateKey);
		const request = {
			templateKey,
			options: choices,
			inputs: sourceTemplateRoles(templateKey, choices).map((role, index) => ({
				role,
				assetId: `capability-${index}`,
			})),
		};
		const configuration = await loadSourceTemplateProvision(templateKey);
		const admitted = resolveSourceTemplateAdmission(
			context,
			request,
			environment,
			bindings,
			configuration,
		);
		// Uploading reserves storage only. Current reference evidence is still checked by
		// access, quote and job admission; uploading another photo need not reread the pack.
		if (!options.forUpload)
			await db.$transaction((tx) =>
				findApprovedSourceTemplateReferences(admitted.request.sourceTemplate, tx, new Date()),
			);
		return {
			available: true,
			reasons: [] as string[],
			maximumInputBytes: 10000000,
			pricing: options.forUpload
				? null
				: {
						version: configuration.receipt.version,
						creditsByOptions: Object.fromEntries(
							configuration.provision.prices.map((price) => [
								sourceTemplatePriceKey(price.options as SourceTemplateChoices),
								price.credits,
							]),
						),
					},
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : "VIDEO_TEMPLATE_NOT_READY";
		return {
			available: false,
			reasons: [
				/^[A-Z][A-Z0-9_]+$/.test(message) ? message : "VIDEO_TEMPLATE_CONFIGURATION_INVALID",
			],
			maximumInputBytes: 10000000,
			pricing: null,
		};
	}
}

export async function createSourceTemplateQuote(
	context: VideoOwnerContext,
	request: SourceTemplatePublicRequest,
	options: {
		bindings: VideoV1Bindings;
		maximumInputBytes: number;
		environment?: Record<string, string | undefined>;
	},
) {
	const admitted = resolveSourceTemplateAdmission(
		context,
		request,
		options.environment ?? process.env,
		options.bindings,
		await loadSourceTemplateProvision(request.templateKey),
	);
	return createVideoQuoteRecord(
		{
			ownerId: context.userId,
			...admitted,
			maximumInputBytes: Math.min(options.maximumInputBytes, admitted.config.maxInputBytes),
		},
		db,
	);
}

/** Resolve accepted intent before mutable source configuration, prices or admission switches. */
export async function findExistingSourceTemplateAdmission(
	ownerId: string,
	idempotencyKey: string,
	request: SourceTemplatePublicRequest,
) {
	const prior = await db.generationJob.findUnique({
		where: { ownerType_ownerId_idempotencyKey: { ownerType: "USER", ownerId, idempotencyKey } },
	});
	if (!prior) return null;
	let frozen: SourceTemplateInternalRequest;
	try {
		frozen = readSourceTemplateInternalRequest(prior.inputSnapshot);
	} catch {
		throw new Error("IDEMPOTENCY_CONFLICT");
	}
	const provided = sourceTemplatePublicRequestSchema.parse(request);
	if (
		canonicalSourceTemplateJson(frozen.sourceTemplate.request) !==
		canonicalSourceTemplateJson({
			...provided,
			options: { ...frozen.sourceTemplate.request.options, ...provided.options },
		})
	)
		throw new Error("IDEMPOTENCY_CONFLICT");
	return findExistingVideoAdmission({ ownerId, idempotencyKey, request: frozen }, db);
}
export async function createSourceTemplateJob(
	context: VideoOwnerContext,
	input: { quoteId: string; idempotencyKey: string; request: SourceTemplatePublicRequest },
	options: {
		bindings: VideoV1Bindings;
		limits: { maximumInputBytes: number; maximumStorageBytes: bigint };
		environment?: Record<string, string | undefined>;
	},
) {
	const respond = async (jobId: string) => {
		await ensureVideoWorkflowStarted(jobId, getVideoWorkflowBinding());
		return getSourceTemplatePublicState(context, jobId);
	};
	const replay = await findExistingSourceTemplateAdmission(
		context.userId,
		input.idempotencyKey,
		input.request,
	);
	if (replay) return respond(replay.id);
	try {
		const configuration = await loadSourceTemplateProvision(input.request.templateKey);
		let admitted: ReturnType<typeof resolveSourceTemplateAdmission>;
		try {
			// Pure validation cannot have created a job. Keep configuration IO and all
			// transaction/transport work outside this proof-producing catch.
			admitted = resolveSourceTemplateAdmission(
				context,
				input.request,
				options.environment ?? process.env,
				options.bindings,
				configuration,
			);
		} catch (error) {
			const code =
				error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message)
					? error.message
					: "VIDEO_TEMPLATE_CONFIGURATION_INVALID";
			throw new SourceTemplateNotAdmittedError(code);
		}
		const result = await createVideoJobRecord(
			{
				...input,
				...admitted,
				ownerId: context.userId,
				requestReceivedAt: new Date(),
				limits: {
					...options.limits,
					maximumInputBytes: Math.min(
						options.limits.maximumInputBytes,
						admitted.config.maxInputBytes,
					),
				},
			},
			db,
		);
		return respond(result.jobId);
	} catch (error) {
		const recovered = await findExistingSourceTemplateAdmission(
			context.userId,
			input.idempotencyKey,
			input.request,
		);
		if (recovered) return respond(recovered.id);
		if (error instanceof Error && definiteAdmissionErrors.has(error.message))
			throw new SourceTemplateNotAdmittedError(error.message);
		throw error;
	}
}
export async function getSourceTemplatePublicState(context: VideoOwnerContext, jobId: string) {
	const state = await getVideoPublicState(context, jobId);
	if (!state.template) throw new Error("NOT_FOUND");
	return state;
}
export async function listSourceTemplatePublicStates(
	context: VideoOwnerContext,
	input: { cursor?: string; limit?: number; templateKey?: string },
) {
	const result = await listVideoJobRecords(
		context.userId,
		{ ...input, sourceTemplateKey: input.templateKey, sourceTemplatesOnly: true },
		db,
	);
	return {
		items: result.rows.map((job) => {
			const state = toVideoPublicState(job);
			if (state.canPlay)
				state.canPlay = Boolean(authorizeVideoPlaybackSnapshot(context.userId, job));
			return state;
		}),
		nextCursor: result.nextCursor,
	};
}
