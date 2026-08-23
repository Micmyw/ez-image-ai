import type { ExecutableRouteGraphOptions, MediaModelInput, ModerationDecision } from "@repo/ai";
import type { ProductModelKey } from "@repo/config";
import { db } from "@repo/database/client";
import {
	createModeratedGenerationQuoteTransaction,
	type CreateModeratedGenerationQuoteInput,
} from "@repo/database/media-quotes";

import { protectedProcedure } from "../../../orpc/procedures";
import { toMediaOrpcError } from "../lib/errors";
import { getCurrentExecutableRouteGraphOptions } from "../lib/executable-route-graph";
import { assertGenerationAllowed } from "../lib/generation-authorization";
import { buildMediaQuote } from "../lib/quote";
import {
	createTextModerationAdapter,
	moderateQuoteInput,
	type TextModerationEvidence,
} from "../lib/text-moderation";
import { createQuoteInputSchema, jsonBigInt } from "../types";

interface CreateQuoteDependencies {
	now(): Date;
	assertAllowed: typeof assertGenerationAllowed;
	getRouteGraphOptions?(): Promise<ExecutableRouteGraphOptions>;
	createAdapter(): {
		provider: TextModerationEvidence["provider"];
		adapter: {
			moderateText(input: { text: string; ruleVersion: string }): Promise<ModerationDecision>;
		};
	};
	persistApproved(input: CreateModeratedGenerationQuoteInput): Promise<{
		id: string;
		productKey: string;
		catalogVersion: string;
		pricingVersion: string;
		credits: bigint;
		expiresAt: Date;
	}>;
	recordDenied(evidence: TextModerationEvidence): Promise<void> | void;
}

const defaultDependencies: CreateQuoteDependencies = {
	now: () => new Date(),
	assertAllowed: (input) => assertGenerationAllowed(input),
	getRouteGraphOptions: () => getCurrentExecutableRouteGraphOptions(),
	createAdapter: () => createTextModerationAdapter(process.env),
	persistApproved: (input) => createModeratedGenerationQuoteTransaction(input, db),
	recordDenied: async (evidence) => {
		await db.auditLog.create({
			data: {
				action: "MEDIA_TEXT_MODERATION_BLOCKED",
				targetType: "GENERATION_QUOTE_REQUEST",
				targetId: evidence.inputFingerprint,
				after: { ...evidence },
				metadata: {},
			},
		});
	},
};

export async function createQuoteForUser(
	userId: string,
	input: { productKey: ProductModelKey; input: MediaModelInput },
	dependencies: CreateQuoteDependencies = defaultDependencies,
) {
	const routeGraphOptions = await dependencies.getRouteGraphOptions?.();
	const quote = buildMediaQuote(input, routeGraphOptions);
	await dependencies.assertAllowed({
		userId,
		productKey: input.productKey,
		credits: quote.credits,
		costMicros: quote.costMicros,
		input: input.input,
		routeGraphOptions,
	});
	const quoteInput = {
		ownerType: "USER" as const,
		ownerId: userId,
		submittedByUserId: userId,
		productKey: input.productKey,
		catalogVersion: quote.catalogVersion,
		pricingVersion: quote.pricingVersion,
		credits: quote.credits,
		costMicros: quote.costMicros,
		inputSnapshot: input.input,
		pricingSnapshot: quote.pricingSnapshot,
		expiresAt: new Date(dependencies.now().getTime() + 10 * 60_000),
	};
	const selection = dependencies.createAdapter();
	return moderateQuoteInput(quoteInput, {
		provider: selection.provider,
		moderateText: (moderationInput) => selection.adapter.moderateText(moderationInput),
		persistApproved: (moderation) => dependencies.persistApproved({ ...quoteInput, moderation }),
		recordDenied: (evidence) => dependencies.recordDenied(evidence),
	});
}

export const createQuote = protectedProcedure
	.route({ method: "POST", path: "/media/quotes", tags: ["Media"] })
	.input(createQuoteInputSchema)
	.handler(async ({ context: { user }, input }) => {
		try {
			const created = await createQuoteForUser(user.id, input);
			return {
				id: created.id,
				productKey: created.productKey,
				catalogVersion: created.catalogVersion,
				pricingVersion: created.pricingVersion,
				credits: jsonBigInt(created.credits),
				expiresAt: created.expiresAt.toISOString(),
			};
		} catch (error) {
			throw toMediaOrpcError(error);
		}
	});
