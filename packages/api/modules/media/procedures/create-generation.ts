import { MEDIA_VERIFICATION_POLICY_VERSION, MEDIA_VERIFICATION_RULE_VERSION } from "@repo/ai";
import { DEFAULT_PRODUCT_CONFIG } from "@repo/config";
import { createGenerationJobTransaction } from "@repo/database";
import { db } from "@repo/database/client";
import { resolveDatabaseDispatchRoute } from "@repo/jobs";
import { logger } from "@repo/logs";
import { tasks } from "@trigger.dev/sdk";

import { protectedProcedure } from "../../../orpc/procedures";
import { dispatchCreatedJobBestEffort } from "../lib/dispatch-created-job";
import { toMediaOrpcError } from "../lib/errors";
import { assertGenerationAllowed } from "../lib/generation-authorization";
import { TEXT_MODERATION_RULE_VERSION } from "../lib/text-moderation";
import { createGenerationInputSchema, jsonBigInt } from "../types";

export const createGeneration = protectedProcedure
	.route({ method: "POST", path: "/media/generations", tags: ["Media"] })
	.input(createGenerationInputSchema)
	.handler(async ({ context: { user }, input }) => {
		try {
			const quote = await db.generationQuote.findFirst({
				where: { id: input.quoteId, ownerType: "USER", ownerId: user.id },
			});
			if (!quote) throw new Error("NOT_FOUND");
			if (quote.expiresAt <= new Date()) throw new Error("QUOTE_EXPIRED");
			if (
				quote.catalogVersion !== DEFAULT_PRODUCT_CONFIG.catalogVersion ||
				quote.pricingVersion !== DEFAULT_PRODUCT_CONFIG.pricingVersion
			) {
				throw new Error("PRICE_CHANGED");
			}
			const inputSnapshot = quote.inputSnapshot as { sourceAssetId?: string };
			await assertGenerationAllowed({
				userId: user.id,
				productKey: quote.productKey as Parameters<typeof assertGenerationAllowed>[0]["productKey"],
				credits: quote.credits,
				costMicros: quote.costMicros,
				input: quote.inputSnapshot as Parameters<typeof assertGenerationAllowed>[0]["input"],
				catalogVersion: quote.catalogVersion,
				pricingVersion: quote.pricingVersion,
				enforceProspectiveDailyBudget: false,
			});
			const result = await createGenerationJobTransaction(
				{
					ownerType: "USER",
					ownerId: user.id,
					submittedByUserId: user.id,
					quoteId: quote.id,
					idempotencyKey: input.idempotencyKey,
					inputAssetIds: inputSnapshot.sourceAssetId ? [inputSnapshot.sourceAssetId] : [],
					expectedModerationRuleVersion: TEXT_MODERATION_RULE_VERSION,
					expectedAssetModerationRuleVersion: MEDIA_VERIFICATION_RULE_VERSION,
					expectedAssetModerationPolicyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
					maximumDailyCostMicros: BigInt(DEFAULT_PRODUCT_CONFIG.budgets.maximumDailyUserCostMicros),
				},
				db,
			);
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
