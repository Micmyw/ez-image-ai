import { ORPCError } from "@orpc/server";
import { DEFAULT_PRODUCT_CONFIG } from "@repo/config";
import type { Prisma } from "@repo/database";
import { createGenerationJobTransaction } from "@repo/database";
import { db } from "@repo/database/client";
import { createModeratedGenerationQuoteTransaction } from "@repo/database/media-quotes";
import { z } from "zod";

import { protectedProcedure } from "../../../orpc/procedures";
import { toMediaOrpcError } from "../lib/errors";
import { assertGenerationAllowed } from "../lib/generation-authorization";
import { buildMediaQuote } from "../lib/quote";
import { buildApprovedRetryQuote } from "../lib/retry-moderation";
import { TEXT_MODERATION_RULE_VERSION } from "../lib/text-moderation";

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
			const source = await db.generationJob.findFirst({
				where: { id: input.jobId, ownerType: "USER", ownerId: user.id, status: "FAILED" },
				include: { assets: { where: { role: "INPUT" } }, quote: true },
			});
			if (!source) throw new ORPCError("NOT_FOUND");
			const currentQuote = buildMediaQuote({
				productKey: source.productKey as Parameters<typeof buildMediaQuote>[0]["productKey"],
				input: source.quote.inputSnapshot as Parameters<typeof buildMediaQuote>[0]["input"],
			});
			await assertGenerationAllowed({
				userId: user.id,
				productKey: source.productKey as Parameters<
					typeof assertGenerationAllowed
				>[0]["productKey"],
				credits: currentQuote.credits,
				costMicros: currentQuote.costMicros,
				input: source.quote.inputSnapshot as Parameters<typeof assertGenerationAllowed>[0]["input"],
				enforceProspectiveDailyBudget: false,
			});
			const quoteInput = buildApprovedRetryQuote({
				sourceQuote: source.quote,
				expectedRuleVersion: TEXT_MODERATION_RULE_VERSION,
				quote: {
					ownerType: "USER",
					ownerId: user.id,
					submittedByUserId: user.id,
					productKey: source.productKey,
					catalogVersion: currentQuote.catalogVersion,
					pricingVersion: currentQuote.pricingVersion,
					credits: currentQuote.credits,
					costMicros: currentQuote.costMicros,
					inputSnapshot: source.quote.inputSnapshot as Prisma.InputJsonValue,
					pricingSnapshot: currentQuote.pricingSnapshot,
					expiresAt: new Date(Date.now() + 10 * 60_000),
				},
			});
			const quote = await createModeratedGenerationQuoteTransaction(quoteInput, db);
			const created = await createGenerationJobTransaction(
				{
					ownerType: "USER",
					ownerId: user.id,
					submittedByUserId: user.id,
					quoteId: quote.id,
					idempotencyKey: input.idempotencyKey,
					inputAssetIds: source.assets.map((binding) => binding.assetId),
					expectedModerationRuleVersion: TEXT_MODERATION_RULE_VERSION,
					maximumDailyCostMicros: BigInt(DEFAULT_PRODUCT_CONFIG.budgets.maximumDailyUserCostMicros),
				},
				db,
			);
			return { jobId: created.job.id, status: created.job.status, replayed: created.replayed };
		} catch (error) {
			throw toMediaOrpcError(error);
		}
	});
