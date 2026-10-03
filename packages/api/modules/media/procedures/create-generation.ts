import {
	MEDIA_VERIFICATION_POLICY_VERSION,
	MEDIA_VERIFICATION_RULE_VERSION,
	type ExecutableRouteGraphOptions,
} from "@repo/ai";
import {
	DEFAULT_PRODUCT_CONFIG,
	EZPIC_PRODUCT_KEYS,
	temporaryReferenceSchema,
	type PlanEntitlement,
} from "@repo/config";
import { mediaDailyProviderCostBudgetMicros } from "@repo/config/server";
import { createGenerationJobTransaction, getInitialGenerationEventIds } from "@repo/database";
import { db } from "@repo/database/client";
import { resolveDatabaseDispatchRoute } from "@repo/jobs";
import { dispatchJob } from "@repo/jobs/orchestration/client";
import { logger } from "@repo/logs";

import { protectedProcedure } from "../../../orpc/procedures";
import { dispatchCreatedJobBestEffort } from "../lib/dispatch-created-job";
import { toMediaOrpcError } from "../lib/errors";
import { getCurrentExecutableRouteGraphOptions } from "../lib/executable-route-graph";
import { createFlowTiming, type FlowTiming } from "../lib/flow-timing";
import { assertGenerationAllowed } from "../lib/generation-authorization";
import { loadUserPlanEntitlement } from "../lib/plan-entitlement";
import { assertFrozenQuoteRouteGraphIsCurrent } from "../lib/quote";
import { enforceMediaRateLimit } from "../lib/rate-limit";
import { maximumMediaStorageBytes } from "../lib/storage-limits";
import {
	TEXT_MODERATION_RULE_VERSION,
	textModerationProviderForEnvironment,
} from "../lib/text-moderation";
import { createGenerationInputSchema, jsonBigInt } from "../types";
import { dispatchUploadVerification } from "./complete-upload-session";

export const createGeneration = protectedProcedure
	.route({ method: "POST", path: "/media/generations", tags: ["Media"] })
	.input(createGenerationInputSchema)
	.handler(async ({ context: { user, requestId }, input }) => {
		try {
			const timing = createFlowTiming({ requestId });
			const result = await createGenerationForUser(user.id, input, undefined, timing);
			await timing.measure("admission.dispatch", () => dispatchCreatedGeneration(result));
			return {
				job: {
					id: result.job.id,
					status: result.job.status,
					version: result.job.version,
					creditsReserved: jsonBigInt(result.job.creditsReserved),
				},
				replayed: result.replayed,
			};
		} catch (error) {
			throw toMediaOrpcError(error);
		}
	});

export async function dispatchCreatedGeneration(result: CreatedGenerationJob): Promise<void> {
	const eventIds =
		result.continuationEventIds ??
		(result.replayed ? await getInitialGenerationEventIds(result.job.id, db) : undefined);
	if (eventIds !== undefined) {
		if (!eventIds.length) return;
		try {
			await dispatchJob(
				"media-deliver-events",
				{ eventIds },
				{
					idempotencyKey: `generation-start:${result.job.id}:${result.job.version}`,
					timeoutMs: 3_000,
				},
			);
		} catch {
			logger.warn("Generation wake deferred to durable recovery", { jobId: result.job.id });
		}
		return;
	}
	if (result.verificationAssetId && !result.replayed) {
		await dispatchUploadVerification(result.verificationAssetId);
	} else {
		await dispatchCreatedJobBestEffort(
			{
				jobId: result.job.id,
				version: result.job.version,
				replayed: result.replayed,
				serviceClass: "STANDARD",
			},
			{
				resolveRoute: resolveDatabaseDispatchRoute,
				dispatch: (task, payload, options) =>
					dispatchJob(task, payload, { ...options, timeoutMs: 3_000 }),
				warn: (message, details) => logger.warn(message, details),
			},
		);
	}
}

export interface GenerationQuoteForCreation {
	id: string;
	productKey: string;
	catalogVersion: string;
	pricingVersion: string;
	expiresAt: Date;
	credits: bigint;
	costMicros: bigint;
	inputSnapshot: unknown;
	pricingSnapshot: unknown;
}

/** Only produced in server memory after qualification and text moderation; never a request DTO. */
export interface PreparedGenerationAdmission {
	ownerId: string;
	quote: GenerationQuoteForCreation;
	routeGraphOptions: ExecutableRouteGraphOptions;
}

interface CreatedGenerationJob {
	continuationEventIds?: string[];
	verificationAssetId?: string;
	job: {
		id: string;
		status: string;
		version: number;
		creditsReserved: bigint;
	};
	replayed: boolean;
}

interface CreateGenerationDependencies {
	now(): Date;
	findQuote(userId: string, quoteId: string): Promise<GenerationQuoteForCreation | null>;
	getRouteGraphOptions(): Promise<ExecutableRouteGraphOptions>;
	loadEntitlement(userId: string): Promise<Pick<PlanEntitlement, "maximumConcurrentJobs">>;
	assertAllowed: typeof assertGenerationAllowed;
	enforceRateLimit?: typeof enforceMediaRateLimit;
	createGenerationJob(input: {
		ownerType: "USER";
		ownerId: string;
		submittedByUserId: string;
		quoteId: string;
		idempotencyKey: string;
		inputAssetIds: string[];
		expectedModerationRuleVersion: string;
		expectedModerationProvider: string;
		expectedAssetModerationRuleVersion: string;
		expectedAssetModerationPolicyVersion: string;
		maximumDailyCostMicros: bigint;
		maximumGlobalDailyCostMicros?: bigint;
		maximumStorageBytes: bigint;
		maximumConcurrentJobs?: number;
		validateCurrentEligibility?: boolean;
		edit?:
			| { kind: "ROOT"; rootAssetId: string }
			| {
					kind: "CHILD";
					parentJobId: string;
					editSessionId: string;
					sourceAssetId: string;
			  };
	}): Promise<CreatedGenerationJob>;
}

const defaultDependencies: CreateGenerationDependencies = {
	now: () => new Date(),
	findQuote: (userId, quoteId) =>
		db.generationQuote.findFirst({
			where: { id: quoteId, ownerType: "USER", ownerId: userId },
		}),
	getRouteGraphOptions: () => getCurrentExecutableRouteGraphOptions(),
	loadEntitlement: (userId) => loadUserPlanEntitlement(userId),
	assertAllowed: (input) => assertGenerationAllowed(input),
	enforceRateLimit: enforceMediaRateLimit,
	createGenerationJob: (input) => createGenerationJobTransaction(input, db),
};

export async function createGenerationForUser(
	userId: string,
	input: { quoteId: string; idempotencyKey: string; parentJobId?: string },
	dependencies: CreateGenerationDependencies = defaultDependencies,
	timing: FlowTiming = createFlowTiming(),
): Promise<CreatedGenerationJob> {
	const quote = await timing.measure("admission.quote.lookup", () =>
		dependencies.findQuote(userId, input.quoteId),
	);
	if (!quote) throw new Error("NOT_FOUND");
	return createGenerationFromQuote(userId, input, quote, dependencies, timing);
}

export async function createGenerationFromApprovedQuote(
	userId: string,
	input: { quoteId: string; idempotencyKey: string; parentJobId?: string },
	admission: PreparedGenerationAdmission,
	dependencies: CreateGenerationDependencies = defaultDependencies,
	timing: FlowTiming = createFlowTiming(),
): Promise<CreatedGenerationJob> {
	if (admission.ownerId !== userId || admission.quote.id !== input.quoteId)
		throw new Error("NOT_FOUND");
	if (process.env.MEDIA_GENERATION_ENABLED !== "true") throw new Error("MODEL_DISABLED");
	// Keep the existing two admission charges; only duplicate data reads are removed.
	await timing.measure("admission.rate-limit", async () =>
		dependencies.enforceRateLimit?.(userId, "media:generation"),
	);
	return createGenerationFromQuote(userId, input, admission.quote, dependencies, timing, admission);
}

async function createGenerationFromQuote(
	userId: string,
	input: { quoteId: string; idempotencyKey: string; parentJobId?: string },
	quote: GenerationQuoteForCreation,
	dependencies: CreateGenerationDependencies,
	timing: FlowTiming,
	admission?: PreparedGenerationAdmission,
): Promise<CreatedGenerationJob> {
	if (quote.expiresAt <= dependencies.now()) throw new Error("QUOTE_EXPIRED");
	if (
		quote.catalogVersion !== DEFAULT_PRODUCT_CONFIG.catalogVersion ||
		quote.pricingVersion !== DEFAULT_PRODUCT_CONFIG.pricingVersion
	) {
		throw new Error("PRICE_CHANGED");
	}
	if (!EZPIC_PRODUCT_KEYS.includes(quote.productKey as (typeof EZPIC_PRODUCT_KEYS)[number])) {
		throw new Error("PRICE_CHANGED");
	}
	const routeGraphOptions =
		admission?.routeGraphOptions ??
		(await timing.measure("admission.config", () => dependencies.getRouteGraphOptions()));
	assertFrozenQuoteRouteGraphIsCurrent(
		{
			productKey: quote.productKey as Parameters<typeof assertGenerationAllowed>[0]["productKey"],
			catalogVersion: quote.catalogVersion,
			pricingVersion: quote.pricingVersion,
			pricingSnapshot: quote.pricingSnapshot,
		},
		routeGraphOptions,
	);
	const inputSnapshot = objectRecord(quote.inputSnapshot);
	const sourceAssetId =
		typeof inputSnapshot.sourceAssetId === "string" ? inputSnapshot.sourceAssetId : undefined;
	const temporaryReference =
		inputSnapshot.temporaryReference === undefined
			? undefined
			: temporaryReferenceSchema.parse(inputSnapshot.temporaryReference);
	if (!admission)
		await timing.measure("admission.eligibility", () =>
			dependencies.assertAllowed({
				userId,
				productKey: quote.productKey as Parameters<typeof assertGenerationAllowed>[0]["productKey"],
				credits: quote.credits,
				costMicros: quote.costMicros,
				input: quote.inputSnapshot as Parameters<typeof assertGenerationAllowed>[0]["input"],
				temporaryReference,
				catalogVersion: quote.catalogVersion,
				pricingVersion: quote.pricingVersion,
				enforceProspectiveDailyBudget: false,
				routeGraphOptions,
			}),
		);
	const entitlement = admission
		? undefined
		: await timing.measure("admission.entitlement", () => dependencies.loadEntitlement(userId));
	const maximumGlobalDailyCostMicros = mediaDailyProviderCostBudgetMicros(process.env);
	const created = await timing.measure("admission.job.transaction", () =>
		dependencies.createGenerationJob({
			ownerType: "USER",
			ownerId: userId,
			submittedByUserId: userId,
			quoteId: quote.id,
			idempotencyKey: input.idempotencyKey,
			inputAssetIds: sourceAssetId ? [sourceAssetId] : [],
			expectedModerationRuleVersion: TEXT_MODERATION_RULE_VERSION,
			expectedModerationProvider: textModerationProviderForEnvironment(process.env),
			expectedAssetModerationRuleVersion: MEDIA_VERIFICATION_RULE_VERSION,
			expectedAssetModerationPolicyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
			maximumDailyCostMicros: BigInt(DEFAULT_PRODUCT_CONFIG.budgets.maximumDailyUserCostMicros),
			...(maximumGlobalDailyCostMicros === undefined ? {} : { maximumGlobalDailyCostMicros }),
			maximumStorageBytes: maximumMediaStorageBytes(),
			validateCurrentEligibility: true,
			...(entitlement ? { maximumConcurrentJobs: entitlement.maximumConcurrentJobs } : {}),
			...imageEditBinding(quote.productKey, inputSnapshot, input.parentJobId),
		}),
	);
	timing.bind({ jobId: created.job.id, assetId: created.verificationAssetId });
	timing.mark("admission.committed", 0);
	return created;
}

function imageEditBinding(
	productKey: string,
	inputSnapshot: Record<string, unknown>,
	parentJobIdEcho: string | undefined,
) {
	if (
		!EZPIC_PRODUCT_KEYS.some((candidate) => candidate === productKey) ||
		inputSnapshot.kind !== "image-to-image" ||
		typeof inputSnapshot.sourceAssetId !== "string"
	) {
		if (parentJobIdEcho || inputSnapshot.editContext !== undefined) {
			throw new Error("NOT_FOUND");
		}
		return {};
	}
	const editContext = inputSnapshot.editContext;
	if (editContext === undefined) {
		if (parentJobIdEcho) throw new Error("NOT_FOUND");
		return {
			edit: { kind: "ROOT" as const, rootAssetId: inputSnapshot.sourceAssetId },
		};
	}
	if (!isRecord(editContext)) throw new Error("NOT_FOUND");
	if (editContext.kind === "ROOT") {
		if (parentJobIdEcho || editContext.rootAssetId !== inputSnapshot.sourceAssetId) {
			throw new Error("NOT_FOUND");
		}
		return {
			edit: { kind: "ROOT" as const, rootAssetId: inputSnapshot.sourceAssetId },
		};
	}
	if (
		editContext.kind !== "CHILD" ||
		typeof editContext.parentJobId !== "string" ||
		!editContext.parentJobId ||
		typeof editContext.editSessionId !== "string" ||
		!editContext.editSessionId ||
		editContext.sourceAssetId !== inputSnapshot.sourceAssetId ||
		(parentJobIdEcho !== undefined && parentJobIdEcho !== editContext.parentJobId)
	) {
		throw new Error("NOT_FOUND");
	}
	return {
		edit: {
			kind: "CHILD" as const,
			parentJobId: editContext.parentJobId,
			editSessionId: editContext.editSessionId,
			sourceAssetId: inputSnapshot.sourceAssetId,
		},
	};
}

function objectRecord(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
