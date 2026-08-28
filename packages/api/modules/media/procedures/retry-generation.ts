import {
	mediaModelInputSchema,
	MEDIA_VERIFICATION_POLICY_VERSION,
	MEDIA_VERIFICATION_RULE_VERSION,
	type ModerationDecision,
} from "@repo/ai";
import { DEFAULT_PRODUCT_CONFIG, productModelKeySchema, type PlanEntitlement } from "@repo/config";
import { mediaDailyProviderCostBudgetMicros } from "@repo/config/server";
import {
	claimGenerationRetryRequest,
	completeGenerationRetryRequest,
	createGenerationRetryQuoteCheckpoint,
	createGenerationJobTransaction,
	failGenerationRetryRequest,
	resumeGenerationRetryRequest,
	type ClaimGenerationRetryRequestInput,
	type CreateGenerationJobInput,
	type CreateGenerationJobResult,
	type GenerationRetryEditContext,
	type GenerationRetryOperation,
	type GenerationRetryRequestClaim,
} from "@repo/database";
import { db } from "@repo/database/client";
import type { CreateModeratedGenerationQuoteInput } from "@repo/database/media-quotes";
import { resolveDatabaseDispatchRoute } from "@repo/jobs";
import { logger } from "@repo/logs";
import { tasks } from "@trigger.dev/sdk";
import { z } from "zod";

import { protectedProcedure } from "../../../orpc/procedures";
import { dispatchCreatedJobBestEffort } from "../lib/dispatch-created-job";
import { stableMediaErrorCode, toMediaOrpcError } from "../lib/errors";
import { assertGenerationAllowed } from "../lib/generation-authorization";
import { loadUserPlanEntitlement } from "../lib/plan-entitlement";
import { buildMediaQuote } from "../lib/quote";
import { maximumMediaStorageBytes } from "../lib/storage-limits";
import {
	createTextModerationAdapter,
	moderateQuoteInput,
	TEXT_MODERATION_RULE_VERSION,
	type TextModerationEvidence,
} from "../lib/text-moderation";

interface RetryGenerationSource {
	id: string;
	productKey: string;
	serviceClass: "STANDARD" | "GUEST_SLOW";
	quote: { inputSnapshot: unknown };
	assets: Array<{ assetId: string; assetChecksum: string }>;
	editSessionId: string | null;
	parentJobId: string | null;
	editSession: {
		ownerType: string;
		ownerId: string;
		rootAssetId: string;
	} | null;
}

export interface RetryGenerationDependencies {
	now(): Date;
	resumeRequest(input: {
		ownerType: "USER";
		ownerId: string;
		submittedByUserId: string;
		sourceJobId: string;
		idempotencyKey: string;
		now?: Date;
	}): Promise<GenerationRetryRequestClaim | null>;
	findSource(input: { userId: string; jobId: string }): Promise<RetryGenerationSource | null>;
	assertAllowed: typeof assertGenerationAllowed;
	loadEntitlement(userId: string): Promise<Pick<PlanEntitlement, "maximumConcurrentJobs">>;
	claimRequest(input: ClaimGenerationRetryRequestInput): Promise<GenerationRetryRequestClaim>;
	createAdapter(): {
		provider: TextModerationEvidence["provider"];
		adapter: {
			moderateText(input: { text: string; ruleVersion: string }): Promise<ModerationDecision>;
		};
	};
	persistApproved(input: {
		requestId: string;
		leaseToken: string;
		quote: CreateModeratedGenerationQuoteInput;
		now?: Date;
	}): Promise<{ id: string }>;
	findCheckpointQuote(quoteId: string): Promise<{ id: string } | null>;
	recordDenied?(evidence: TextModerationEvidence): Promise<void> | void;
	createJob(input: CreateGenerationJobInput): Promise<CreateGenerationJobResult>;
	completeRequest(input: {
		requestId: string;
		leaseToken: string;
		quoteId: string;
		resultJobId: string;
	}): Promise<boolean>;
	failRequest(input: {
		requestId: string;
		leaseToken: string;
		errorCode: string;
	}): Promise<boolean>;
	getJob(jobId: string): Promise<{ id: string; status: string } | null>;
	dispatch(input: { jobId: string; version: number; replayed: boolean }): Promise<unknown>;
}

const defaultDependencies: RetryGenerationDependencies = {
	now: () => new Date(),
	resumeRequest: (input) => resumeGenerationRetryRequest(input, db),
	findSource: ({ userId, jobId }) =>
		db.generationJob.findFirst({
			where: {
				id: jobId,
				ownerType: "USER",
				ownerId: userId,
				status: "FAILED",
				serviceClass: "STANDARD",
			},
			include: {
				assets: { where: { role: "INPUT" }, orderBy: [{ position: "asc" }, { id: "asc" }] },
				quote: true,
				editSession: true,
			},
		}),
	assertAllowed: (input) => assertGenerationAllowed(input),
	loadEntitlement: (userId) => loadUserPlanEntitlement(userId),
	claimRequest: (input) => claimGenerationRetryRequest(input, db),
	createAdapter: () => createTextModerationAdapter(process.env),
	persistApproved: (input) => createGenerationRetryQuoteCheckpoint(input, db),
	findCheckpointQuote: (quoteId) =>
		db.generationQuote.findUnique({ where: { id: quoteId }, select: { id: true } }),
	recordDenied: async (evidence) => {
		await db.auditLog.create({
			data: {
				action: "MEDIA_TEXT_MODERATION_BLOCKED",
				targetType: "GENERATION_RETRY_REQUEST",
				targetId: evidence.inputFingerprint,
				after: { ...evidence },
				metadata: {},
			},
		});
	},
	createJob: (input) => createGenerationJobTransaction(input, db),
	completeRequest: (input) => completeGenerationRetryRequest(input, db),
	failRequest: (input) => failGenerationRetryRequest(input, db),
	getJob: (jobId) =>
		db.generationJob.findUnique({ where: { id: jobId }, select: { id: true, status: true } }),
	dispatch: (input) =>
		dispatchCreatedJobBestEffort(
			{ ...input, serviceClass: "STANDARD" },
			{
				resolveRoute: resolveDatabaseDispatchRoute,
				trigger: (taskId, payload) => tasks.trigger(taskId, payload).then(() => undefined),
				warn: (message, details) => logger.warn(message, details),
			},
		),
};

export async function retryGenerationForUser(
	userId: string,
	input: { jobId: string; idempotencyKey: string },
	dependencies: RetryGenerationDependencies = defaultDependencies,
): Promise<{ jobId: string; status: string; replayed: boolean }> {
	let claim = await dependencies.resumeRequest({
		ownerType: "USER",
		ownerId: userId,
		submittedByUserId: userId,
		sourceJobId: input.jobId,
		idempotencyKey: input.idempotencyKey,
		now: dependencies.now(),
	});
	let selection: ReturnType<RetryGenerationDependencies["createAdapter"]> | undefined;
	if (!claim) {
		const source = await dependencies.findSource({ userId, jobId: input.jobId });
		if (!source || source.serviceClass !== "STANDARD") throw new Error("NOT_FOUND");
		const productKey = productModelKeySchema.parse(source.productKey);
		const normalizedInput = mediaModelInputSchema.parse(source.quote.inputSnapshot);
		const editContext = retryEditContextForSource(userId, source, normalizedInput);
		const currentQuote = buildMediaQuote({ productKey, input: normalizedInput });
		selection = dependencies.createAdapter();
		const operation: GenerationRetryOperation = {
			sourceJobId: source.id,
			productKey,
			normalizedInput,
			inputAssets: source.assets.map(({ assetId, assetChecksum }) => ({
				assetId,
				assetChecksum,
			})),
			catalogVersion: currentQuote.catalogVersion,
			pricingVersion: currentQuote.pricingVersion,
			credits: currentQuote.credits.toString(),
			costMicros: currentQuote.costMicros.toString(),
			pricingSnapshot: currentQuote.pricingSnapshot,
			moderationProvider: selection.provider,
			moderationRuleVersion: TEXT_MODERATION_RULE_VERSION,
			assetModerationRuleVersion: MEDIA_VERIFICATION_RULE_VERSION,
			assetModerationPolicyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
			...(editContext ? { editContext } : {}),
		};
		claim = await dependencies.claimRequest({
			ownerType: "USER",
			ownerId: userId,
			submittedByUserId: userId,
			idempotencyKey: input.idempotencyKey,
			operation,
			now: dependencies.now(),
		});
	}

	if (claim.outcome === "SUCCEEDED") {
		const resultJob = await dependencies.getJob(claim.resultJobId);
		if (!resultJob) throw new Error("GENERATION_RETRY_RESULT_MISSING");
		return { jobId: resultJob.id, status: resultJob.status, replayed: true };
	}
	if (claim.outcome === "IN_PROGRESS") throw new Error("GENERATION_RETRY_IN_PROGRESS");
	if (claim.outcome === "FAILED") throw new Error(claim.errorCode);
	const operation = claim.operation;
	const productKey = productModelKeySchema.parse(operation.productKey);
	const normalizedInput = mediaModelInputSchema.parse(operation.normalizedInput);

	let jobCreated = false;
	let jobCreationStarted = false;
	try {
		await dependencies.assertAllowed({
			userId,
			productKey,
			credits: BigInt(operation.credits),
			costMicros: BigInt(operation.costMicros),
			input: normalizedInput,
			catalogVersion: operation.catalogVersion,
			pricingVersion: operation.pricingVersion,
			enforceProspectiveDailyBudget: false,
		});
		const entitlement = await dependencies.loadEntitlement(userId);
		const maximumGlobalDailyCostMicros = mediaDailyProviderCostBudgetMicros(process.env);
		const quoteInput = {
			ownerType: "USER" as const,
			ownerId: userId,
			submittedByUserId: userId,
			productKey,
			catalogVersion: operation.catalogVersion,
			pricingVersion: operation.pricingVersion,
			credits: BigInt(operation.credits),
			costMicros: BigInt(operation.costMicros),
			inputSnapshot: retryQuoteInputSnapshot(normalizedInput, operation.editContext),
			pricingSnapshot: operation.pricingSnapshot,
			expiresAt: new Date(dependencies.now().getTime() + 10 * 60_000),
		};
		if (!claim.quoteId) {
			if (
				operation.moderationRuleVersion !== TEXT_MODERATION_RULE_VERSION ||
				operation.assetModerationRuleVersion !== MEDIA_VERIFICATION_RULE_VERSION ||
				operation.assetModerationPolicyVersion !== MEDIA_VERIFICATION_POLICY_VERSION
			) {
				throw new Error("GENERATION_RETRY_POLICY_CHANGED");
			}
			selection ??= dependencies.createAdapter();
			if (selection.provider !== operation.moderationProvider) {
				throw new Error("GENERATION_RETRY_MODERATION_PROVIDER_CHANGED");
			}
		}
		const quote = claim.quoteId
			? await dependencies.findCheckpointQuote(claim.quoteId)
			: await moderateQuoteInput(quoteInput, {
					provider: selection!.provider,
					moderateText: (moderationInput) => selection!.adapter.moderateText(moderationInput),
					persistApproved: (moderation) =>
						dependencies.persistApproved({
							requestId: claim.requestId,
							leaseToken: claim.leaseToken,
							quote: { ...quoteInput, moderation },
							now: dependencies.now(),
						}),
					recordDenied: (evidence) => dependencies.recordDenied?.(evidence),
				});
		if (!quote) throw new Error("GENERATION_RETRY_QUOTE_CHECKPOINT_MISSING");
		jobCreationStarted = true;
		const created = await dependencies.createJob({
			ownerType: "USER",
			ownerId: userId,
			submittedByUserId: userId,
			quoteId: quote.id,
			idempotencyKey: input.idempotencyKey,
			inputAssetIds: operation.inputAssets.map((binding) => binding.assetId),
			expectedInputAssets: operation.inputAssets.map(({ assetId, assetChecksum }) => ({
				assetId,
				assetChecksum,
			})),
			expectedModerationRuleVersion: operation.moderationRuleVersion,
			expectedAssetModerationRuleVersion: operation.assetModerationRuleVersion,
			expectedAssetModerationPolicyVersion: operation.assetModerationPolicyVersion,
			maximumDailyCostMicros: BigInt(DEFAULT_PRODUCT_CONFIG.budgets.maximumDailyUserCostMicros),
			...(maximumGlobalDailyCostMicros === undefined ? {} : { maximumGlobalDailyCostMicros }),
			maximumStorageBytes: maximumMediaStorageBytes(),
			maximumConcurrentJobs: entitlement.maximumConcurrentJobs,
			...(operation.editContext ? { edit: operation.editContext } : {}),
		});
		jobCreated = true;
		await dependencies.completeRequest({
			requestId: claim.requestId,
			leaseToken: claim.leaseToken,
			quoteId: quote.id,
			resultJobId: created.job.id,
		});
		await dependencies
			.dispatch({
				jobId: created.job.id,
				version: created.job.version,
				replayed: created.replayed,
			})
			.catch(() => undefined);
		return { jobId: created.job.id, status: created.job.status, replayed: created.replayed };
	} catch (error) {
		const errorCode = stableMediaErrorCode(error);
		// Once createJob starts, an exception cannot prove that PostgreSQL did not
		// commit and only the acknowledgement was lost. Resolve the durable job by
		// the same idempotency key before deciding that this request failed.
		const mayHaveCommitted = jobCreationStarted || errorCode === "IDEMPOTENCY_CONFLICT";
		if (!jobCreated && mayHaveCommitted) {
			const recovered = await dependencies
				.resumeRequest({
					ownerType: "USER",
					ownerId: userId,
					submittedByUserId: userId,
					sourceJobId: input.jobId,
					idempotencyKey: input.idempotencyKey,
					now: dependencies.now(),
				})
				.catch(() => null);
			if (recovered?.outcome === "SUCCEEDED") {
				const resultJob = await dependencies.getJob(recovered.resultJobId);
				if (!resultJob) throw new Error("GENERATION_RETRY_RESULT_MISSING");
				return { jobId: resultJob.id, status: resultJob.status, replayed: true };
			}
			if (recovered?.outcome === "FAILED") throw new Error(recovered.errorCode);
		}
		if (!jobCreated && !mayHaveCommitted) {
			await dependencies
				.failRequest({
					requestId: claim.requestId,
					leaseToken: claim.leaseToken,
					errorCode,
				})
				.catch(() => undefined);
		}
		throw error;
	}
}

function retryEditContextForSource(
	userId: string,
	source: RetryGenerationSource,
	normalizedInput: ReturnType<typeof mediaModelInputSchema.parse>,
): GenerationRetryEditContext | undefined {
	const originalContext = quoteEditContext(source.quote.inputSnapshot);
	if (!source.editSessionId && !source.parentJobId && !source.editSession && !originalContext) {
		return undefined;
	}
	if (
		normalizedInput.kind !== "image-to-image" ||
		!source.editSessionId ||
		source.editSession?.ownerType !== "USER" ||
		source.editSession.ownerId !== userId ||
		!originalContext
	) {
		throw new Error("NOT_FOUND");
	}
	if (!source.parentJobId) {
		const rootAssetId = source.editSession.rootAssetId;
		if (
			(originalContext.kind !== "ROOT" && originalContext.kind !== "ROOT_RETRY") ||
			originalContext.rootAssetId !== rootAssetId ||
			normalizedInput.sourceAssetId !== rootAssetId ||
			(originalContext.kind === "ROOT_RETRY" &&
				originalContext.editSessionId !== source.editSessionId)
		) {
			throw new Error("NOT_FOUND");
		}
		return { kind: "ROOT_RETRY", editSessionId: source.editSessionId, rootAssetId };
	}
	if (
		originalContext.kind !== "CHILD" ||
		originalContext.parentJobId !== source.parentJobId ||
		originalContext.editSessionId !== source.editSessionId ||
		originalContext.sourceAssetId !== normalizedInput.sourceAssetId
	) {
		throw new Error("NOT_FOUND");
	}
	return {
		kind: "CHILD",
		parentJobId: source.parentJobId,
		editSessionId: source.editSessionId,
		sourceAssetId: normalizedInput.sourceAssetId,
	};
}

type QuoteEditContext =
	| { kind: "ROOT"; rootAssetId: string }
	| { kind: "ROOT_RETRY"; editSessionId: string; rootAssetId: string }
	| { kind: "CHILD"; parentJobId: string; editSessionId: string; sourceAssetId: string };

function quoteEditContext(inputSnapshot: unknown): QuoteEditContext | null {
	if (!isRecord(inputSnapshot)) return null;
	const value = inputSnapshot.editContext;
	if (value === undefined) return null;
	if (!isRecord(value)) throw new Error("NOT_FOUND");
	if (value.kind === "ROOT" && typeof value.rootAssetId === "string" && value.rootAssetId) {
		return { kind: "ROOT", rootAssetId: value.rootAssetId };
	}
	if (
		value.kind === "ROOT_RETRY" &&
		typeof value.editSessionId === "string" &&
		value.editSessionId &&
		typeof value.rootAssetId === "string" &&
		value.rootAssetId
	) {
		return {
			kind: "ROOT_RETRY",
			editSessionId: value.editSessionId,
			rootAssetId: value.rootAssetId,
		};
	}
	if (
		value.kind === "CHILD" &&
		typeof value.parentJobId === "string" &&
		value.parentJobId &&
		typeof value.editSessionId === "string" &&
		value.editSessionId &&
		typeof value.sourceAssetId === "string" &&
		value.sourceAssetId
	) {
		return {
			kind: "CHILD",
			parentJobId: value.parentJobId,
			editSessionId: value.editSessionId,
			sourceAssetId: value.sourceAssetId,
		};
	}
	throw new Error("NOT_FOUND");
}

function retryQuoteInputSnapshot(
	normalizedInput: ReturnType<typeof mediaModelInputSchema.parse>,
	editContext: GenerationRetryEditContext | undefined,
) {
	return editContext ? { ...normalizedInput, editContext } : normalizedInput;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export const retryGeneration = protectedProcedure
	.route({ method: "POST", path: "/media/jobs/{jobId}/retry", tags: ["Media"] })
	.input(
		z.object({
			jobId: z.string().min(1).max(128),
			idempotencyKey: z.string().trim().min(8).max(128),
		}),
	)
	.handler(async ({ context: { user }, input }) => {
		try {
			return await retryGenerationForUser(user.id, input);
		} catch (error) {
			throw toMediaOrpcError(error);
		}
	});
