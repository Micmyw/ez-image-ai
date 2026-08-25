import {
	MEDIA_VERIFICATION_POLICY_VERSION,
	MEDIA_VERIFICATION_RULE_VERSION,
	type ExecutableRouteGraphOptions,
} from "@repo/ai";
import { DEFAULT_PRODUCT_CONFIG } from "@repo/config";
import { createGenerationJobTransaction } from "@repo/database";
import { db } from "@repo/database/client";
import { resolveDatabaseDispatchRoute } from "@repo/jobs";
import { logger } from "@repo/logs";
import { tasks } from "@trigger.dev/sdk";

import { protectedProcedure } from "../../../orpc/procedures";
import { dispatchCreatedJobBestEffort } from "../lib/dispatch-created-job";
import { toMediaOrpcError } from "../lib/errors";
import { getCurrentExecutableRouteGraphOptions } from "../lib/executable-route-graph";
import { assertGenerationAllowed } from "../lib/generation-authorization";
import { assertFrozenQuoteRouteGraphIsCurrent } from "../lib/quote";
import { maximumMediaStorageBytes } from "../lib/storage-limits";
import { TEXT_MODERATION_RULE_VERSION } from "../lib/text-moderation";
import { createGenerationInputSchema, jsonBigInt } from "../types";

export const createGeneration = protectedProcedure
	.route({ method: "POST", path: "/media/generations", tags: ["Media"] })
	.input(createGenerationInputSchema)
	.handler(async ({ context: { user }, input }) => {
		try {
			const result = await createGenerationForUser(user.id, input);
			await dispatchCreatedJobBestEffort(
				{
					jobId: result.job.id,
					version: result.job.version,
					replayed: result.replayed,
				},
				{
					resolveRoute: resolveDatabaseDispatchRoute,
					trigger: (taskId, payload) => tasks.trigger(taskId, payload).then(() => undefined),
					warn: (message, details) => logger.warn(message, details),
				},
			);
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

interface GenerationQuoteForCreation {
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

interface CreatedGenerationJob {
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
	assertAllowed: typeof assertGenerationAllowed;
	createGenerationJob(input: {
		ownerType: "USER";
		ownerId: string;
		submittedByUserId: string;
		quoteId: string;
		idempotencyKey: string;
		inputAssetIds: string[];
		expectedModerationRuleVersion: string;
		expectedAssetModerationRuleVersion: string;
		expectedAssetModerationPolicyVersion: string;
		maximumDailyCostMicros: bigint;
		maximumStorageBytes: bigint;
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
	assertAllowed: (input) => assertGenerationAllowed(input),
	createGenerationJob: (input) => createGenerationJobTransaction(input, db),
};

export async function createGenerationForUser(
	userId: string,
	input: { quoteId: string; idempotencyKey: string; parentJobId?: string },
	dependencies: CreateGenerationDependencies = defaultDependencies,
): Promise<CreatedGenerationJob> {
	const quote = await dependencies.findQuote(userId, input.quoteId);
	if (!quote) throw new Error("NOT_FOUND");
	if (quote.expiresAt <= dependencies.now()) throw new Error("QUOTE_EXPIRED");
	if (
		quote.catalogVersion !== DEFAULT_PRODUCT_CONFIG.catalogVersion ||
		quote.pricingVersion !== DEFAULT_PRODUCT_CONFIG.pricingVersion
	) {
		throw new Error("PRICE_CHANGED");
	}
	const routeGraphOptions = await dependencies.getRouteGraphOptions();
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
	await dependencies.assertAllowed({
		userId,
		productKey: quote.productKey as Parameters<typeof assertGenerationAllowed>[0]["productKey"],
		credits: quote.credits,
		costMicros: quote.costMicros,
		input: quote.inputSnapshot as Parameters<typeof assertGenerationAllowed>[0]["input"],
		catalogVersion: quote.catalogVersion,
		pricingVersion: quote.pricingVersion,
		enforceProspectiveDailyBudget: false,
		routeGraphOptions,
	});
	return dependencies.createGenerationJob({
		ownerType: "USER",
		ownerId: userId,
		submittedByUserId: userId,
		quoteId: quote.id,
		idempotencyKey: input.idempotencyKey,
		inputAssetIds: sourceAssetId ? [sourceAssetId] : [],
		expectedModerationRuleVersion: TEXT_MODERATION_RULE_VERSION,
		expectedAssetModerationRuleVersion: MEDIA_VERIFICATION_RULE_VERSION,
		expectedAssetModerationPolicyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
		maximumDailyCostMicros: BigInt(DEFAULT_PRODUCT_CONFIG.budgets.maximumDailyUserCostMicros),
		maximumStorageBytes: maximumMediaStorageBytes(),
		...imageEditBinding(quote.productKey, inputSnapshot, input.parentJobId),
	});
}

function imageEditBinding(
	productKey: string,
	inputSnapshot: Record<string, unknown>,
	parentJobIdEcho: string | undefined,
) {
	if (
		(productKey !== "image-fast" && productKey !== "image-quality") ||
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
