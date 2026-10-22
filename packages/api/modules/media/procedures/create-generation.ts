import {
	MEDIA_VERIFICATION_POLICY_VERSION,
	MEDIA_VERIFICATION_RULE_VERSION,
	type ExecutableRouteGraphOptions,
} from "@repo/ai";
import { DEFAULT_PRODUCT_CONFIG, EZPIC_PRODUCT_KEYS, temporaryReferenceSchema } from "@repo/config";
import { mediaDailyProviderCostBudgetMicros } from "@repo/config/server";
import { createGenerationJobTransaction, getInitialGenerationEventIds } from "@repo/database";
import { db } from "@repo/database/client";
import {
	generationFundingSource,
	type GenerationFundingSource,
} from "@repo/database/media-image-passes";
import type { CreateModeratedGenerationQuoteInput } from "@repo/database/media-quotes";
import { resolveDatabaseDispatchRoute } from "@repo/jobs";
import { dispatchJob } from "@repo/jobs/orchestration/client";
import { logger } from "@repo/logs";
import type { RequestDefer } from "@repo/utils/request-lifecycle";

import { protectedProcedure } from "../../../orpc/procedures";
import { dispatchCreatedJobBestEffort } from "../lib/dispatch-created-job";
import { toMediaOrpcError } from "../lib/errors";
import { getCurrentExecutableRouteGraphOptions } from "../lib/executable-route-graph";
import { createFlowTiming, type FlowTiming } from "../lib/flow-timing";
import {
	assertGenerationAllowed,
	createGenerationRateLimitReceipt,
	type GenerationRateLimitReceipt,
} from "../lib/generation-authorization";
import { assertFrozenQuoteRouteGraphIsCurrent } from "../lib/quote";
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
	.handler(async ({ context: { user, requestId, defer }, input }) => {
		try {
			const timing = createFlowTiming({ requestId });
			// A durable replay still belongs to this incoming HTTP request's flood bucket.
			const rateLimitReceipt = await timing.measure("admission.rate-limit", () =>
				createGenerationRateLimitReceipt(user.id),
			);
			const result = await createGenerationForUser(
				user.id,
				input,
				undefined,
				timing,
				rateLimitReceipt,
			);
			await startCreatedGenerationDispatch(result, timing, defer);
			return {
				job: {
					id: result.job.id,
					status: result.job.status,
					version: result.job.version,
					creditsReserved: jsonBigInt(result.job.creditsReserved),
					fundingSource: result.job.fundingSource ?? "CREDITS",
					imagePassUnits: result.job.imagePassUnits ?? 0,
				},
				replayed: result.replayed,
			};
		} catch (error) {
			throw toMediaOrpcError(error);
		}
	});

/** Start only after durable admission. The optional hook owns short wake work, not generation. */
export async function startCreatedGenerationDispatch(
	result: CreatedGenerationJob,
	timing: FlowTiming,
	defer?: RequestDefer,
	dispatch: typeof dispatchCreatedGeneration = dispatchCreatedGeneration,
): Promise<void> {
	// Observed transaction return, not a database clock. Replays have no new commit.
	const observedAt = performance.now();
	const boundary = result.replayed ? "admission.replay_to_wake" : "admission.commit_to_wake";
	const task = timing.measure(defer ? "background.dispatch" : "admission.dispatch", async () => {
		timing.mark(`${boundary}.start`, performance.now() - observedAt);
		try {
			await dispatch(result);
		} finally {
			timing.mark(`${boundary}.complete`, performance.now() - observedAt);
		}
	});
	if (!defer) {
		await task;
		return;
	}
	// A replay lookup can also reject. A committed job remains recoverable and accepted.
	const background = task.catch(() => {
		logger.warn("Generation wake deferred to durable recovery", { jobId: result.job.id });
	});
	try {
		defer(background);
	} catch {
		// Registration may fail after accepting the task. Await the same work, never redispatch.
		timing.mark("admission.defer.fallback", 0);
		await background;
	}
}

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
	/** Present only when quote persistence belongs to the job admission transaction. */
	preparedQuote?: CreateModeratedGenerationQuoteInput;
}

interface CreatedGenerationJob {
	continuationEventIds?: string[];
	verificationAssetId?: string;
	committedQuote?: Pick<
		GenerationQuoteForCreation,
		"id" | "productKey" | "credits" | "pricingSnapshot" | "expiresAt"
	>;
	job: {
		id: string;
		status: string;
		version: number;
		creditsReserved: bigint;
		fundingSource?: GenerationFundingSource;
		imagePassUnits?: 0 | 1;
	};
	replayed: boolean;
}

type ExistingGeneration = Omit<CreatedGenerationJob["job"], "fundingSource"> & {
	fundingSource?: string;
	quoteId: string;
	parentJobId: string | null;
};

interface CreateGenerationDependencies {
	now(): Date;
	findExistingGeneration?(
		userId: string,
		idempotencyKey: string,
	): Promise<ExistingGeneration | null>;
	findQuote(userId: string, quoteId: string): Promise<GenerationQuoteForCreation | null>;
	getRouteGraphOptions(): Promise<ExecutableRouteGraphOptions>;
	assertAllowed: typeof assertGenerationAllowed;
	createGenerationJob(input: {
		ownerType: "USER";
		ownerId: string;
		submittedByUserId: string;
		quoteId: string;
		idempotencyKey: string;
		preparedQuote?: CreateModeratedGenerationQuoteInput;
		inputAssetIds: string[];
		expectedModerationRuleVersion: string;
		expectedModerationProvider: string;
		expectedAssetModerationRuleVersion: string;
		expectedAssetModerationPolicyVersion: string;
		maximumDailyCostMicros: bigint;
		maximumGlobalDailyCostMicros?: bigint;
		maximumStorageBytes: bigint;
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
	findExistingGeneration: (userId, idempotencyKey) =>
		db.generationJob.findUnique({
			where: {
				ownerType_ownerId_idempotencyKey: { ownerType: "USER", ownerId: userId, idempotencyKey },
			},
			select: {
				id: true,
				quoteId: true,
				parentJobId: true,
				status: true,
				version: true,
				creditsReserved: true,
				fundingSource: true,
			},
		}),
	findQuote: (userId, quoteId) =>
		db.generationQuote.findFirst({
			where: { id: quoteId, ownerType: "USER", ownerId: userId },
		}),
	getRouteGraphOptions: () => getCurrentExecutableRouteGraphOptions(),
	assertAllowed: (input) => assertGenerationAllowed(input),
	createGenerationJob: (input) => createGenerationJobTransaction(input, db),
};

export async function createGenerationForUser(
	userId: string,
	input: {
		quoteId: string;
		idempotencyKey: string;
		parentJobId?: string;
		fundingSource?: GenerationFundingSource;
	},
	dependencies: CreateGenerationDependencies = defaultDependencies,
	timing: FlowTiming = createFlowTiming(),
	rateLimitReceipt?: GenerationRateLimitReceipt,
): Promise<CreatedGenerationJob> {
	const replay = async () => {
		const existing = await dependencies.findExistingGeneration?.(userId, input.idempotencyKey);
		if (!existing) return null;
		const fundingSource = generationFundingSource({
			fundingSource: existing.fundingSource ?? "CREDITS",
		});
		if ((input.fundingSource ?? "CREDITS") !== fundingSource)
			throw new Error("GENERATION_FUNDING_CONFLICT");
		if (existing.quoteId !== input.quoteId || existing.parentJobId !== (input.parentJobId ?? null))
			throw new Error("IDEMPOTENCY_CONFLICT");
		timing.bind({ jobId: existing.id });
		return {
			job: {
				...existing,
				fundingSource,
				imagePassUnits: fundingSource === "IMAGE_PASS" ? (1 as const) : (0 as const),
			},
			replayed: true,
		};
	};
	const existing = await replay();
	if (existing) return existing;
	try {
		const quote = await timing.measure("admission.quote.lookup", () =>
			dependencies.findQuote(userId, input.quoteId),
		);
		if (!quote) throw new Error("NOT_FOUND");
		return await createGenerationFromQuote(
			userId,
			input,
			quote,
			dependencies,
			timing,
			undefined,
			rateLimitReceipt,
		);
	} catch (error) {
		// Another request may have committed while this one checked the now-empty pass balance.
		const committed = await replay();
		if (committed) return committed;
		throw error;
	}
}

export async function createGenerationFromApprovedQuote(
	userId: string,
	input: {
		quoteId: string;
		idempotencyKey: string;
		parentJobId?: string;
		fundingSource?: GenerationFundingSource;
	},
	admission: PreparedGenerationAdmission,
	dependencies: CreateGenerationDependencies = defaultDependencies,
	timing: FlowTiming = createFlowTiming(),
): Promise<CreatedGenerationJob> {
	if (admission.ownerId !== userId || admission.quote.id !== input.quoteId)
		throw new Error("NOT_FOUND");
	if (process.env.MEDIA_GENERATION_ENABLED !== "true") throw new Error("MODEL_DISABLED");
	// The same server request already passed its generation flood guard while preparing
	// this text-approved quote. The job transaction still rechecks mutable eligibility.
	return createGenerationFromQuote(userId, input, admission.quote, dependencies, timing, admission);
}

async function createGenerationFromQuote(
	userId: string,
	input: {
		quoteId: string;
		idempotencyKey: string;
		parentJobId?: string;
		fundingSource?: GenerationFundingSource;
	},
	quote: GenerationQuoteForCreation,
	dependencies: CreateGenerationDependencies,
	timing: FlowTiming,
	admission?: PreparedGenerationAdmission,
	rateLimitReceipt?: GenerationRateLimitReceipt,
): Promise<CreatedGenerationJob> {
	const fundingSource = generationFundingSource(quote.pricingSnapshot);
	if ((input.fundingSource ?? "CREDITS") !== fundingSource)
		throw new Error("GENERATION_FUNDING_CONFLICT");
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
				rateLimitReceipt,
				userId,
				fundingSource,
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
	const maximumGlobalDailyCostMicros = mediaDailyProviderCostBudgetMicros(process.env);
	const created = await timing.measure("admission.job.transaction", () =>
		dependencies.createGenerationJob({
			ownerType: "USER",
			ownerId: userId,
			submittedByUserId: userId,
			quoteId: quote.id,
			idempotencyKey: input.idempotencyKey,
			...(admission?.preparedQuote ? { preparedQuote: admission.preparedQuote } : {}),
			inputAssetIds: sourceAssetId ? [sourceAssetId] : [],
			expectedModerationRuleVersion: TEXT_MODERATION_RULE_VERSION,
			expectedModerationProvider: textModerationProviderForEnvironment(process.env),
			expectedAssetModerationRuleVersion: MEDIA_VERIFICATION_RULE_VERSION,
			expectedAssetModerationPolicyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
			maximumDailyCostMicros: BigInt(DEFAULT_PRODUCT_CONFIG.budgets.maximumDailyUserCostMicros),
			...(maximumGlobalDailyCostMicros === undefined ? {} : { maximumGlobalDailyCostMicros }),
			maximumStorageBytes: maximumMediaStorageBytes(),
			validateCurrentEligibility: true,
			...imageEditBinding(quote.productKey, inputSnapshot, input.parentJobId),
		}),
	);
	timing.bind({ jobId: created.job.id, assetId: created.verificationAssetId });
	timing.mark("admission.committed", 0);
	return {
		...created,
		job: { ...created.job, fundingSource, imagePassUnits: fundingSource === "IMAGE_PASS" ? 1 : 0 },
	};
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
