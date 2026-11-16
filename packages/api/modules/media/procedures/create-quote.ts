import type { ExecutableRouteGraphOptions, MediaModelInput, ModerationDecision } from "@repo/ai";
import { EZPIC_PRODUCT_KEYS } from "@repo/config";
import {
	findGenerationSubmissionQuote,
	recordBlockedPromptAttempt,
	type BlockedPromptContext,
} from "@repo/database";
import { findEligibleImageEditParentForOwner } from "@repo/database";
import { db } from "@repo/database/client";
import { type GenerationFundingSource } from "@repo/database/media-image-passes";
import {
	createModeratedGenerationQuoteTransaction,
	type CreateModeratedGenerationQuoteInput,
} from "@repo/database/media-quotes";
import { z } from "zod";

import { protectedProcedure } from "../../../orpc/procedures";
import { toMediaOrpcError } from "../lib/errors";
import { getCurrentExecutableRouteGraphOptions } from "../lib/executable-route-graph";
import { createFlowTiming, type FlowTiming } from "../lib/flow-timing";
import {
	assertGenerationAllowed,
	createGenerationRateLimitReceipt,
	type GenerationRateLimitReceipt,
} from "../lib/generation-authorization";
import {
	assertMatchingSubmission,
	generationSubmissionIdentity,
} from "../lib/generation-submission-identity";
import { buildMediaQuote } from "../lib/quote";
import { enforceMediaRateLimit } from "../lib/rate-limit";
import { verifyTemporaryReference } from "../lib/temporary-reference-token";
import {
	createTextModerationAdapter,
	moderateQuoteInput,
	type TextModerationEvidence,
} from "../lib/text-moderation";
import { createGenerationInputSchema, createQuoteInputSchema, jsonBigInt } from "../types";
import type { PreparedGenerationAdmission } from "./create-generation";

interface CreatedGenerationQuote {
	pricingSnapshot: unknown;
	fundingSource: GenerationFundingSource;
	imagePassUnits: 0 | 1;
	id: string;
	productKey: string;
	catalogVersion: string;
	pricingVersion: string;
	credits: bigint;
	expiresAt: Date;
	admission?: PreparedGenerationAdmission;
}

interface CreateQuoteDependencies {
	now(): Date;
	assertAllowed: typeof assertGenerationAllowed;
	findEligibleEditParent?(
		userId: string,
		parentJobId: string,
		sourceAssetId: string,
	): Promise<{
		editSessionId: string;
		parentJobId: string;
		sourceAssetId: string;
	} | null>;
	getRouteGraphOptions?(): Promise<ExecutableRouteGraphOptions>;
	createAdapter(): {
		provider: TextModerationEvidence["provider"];
		adapter: {
			moderateText(input: {
				text: string;
				ruleVersion: string;
				idempotencyKey?: string;
			}): Promise<ModerationDecision>;
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
	recordDenied(
		evidence: TextModerationEvidence,
		context: BlockedPromptContext,
	): Promise<void> | void;
}

type CurrentEzPicProductKey = (typeof EZPIC_PRODUCT_KEYS)[number];

const defaultDependencies: CreateQuoteDependencies = {
	now: () => new Date(),
	assertAllowed: (input) => assertGenerationAllowed(input),
	findEligibleEditParent: (userId, parentJobId, sourceAssetId) =>
		findEligibleImageEditParentForOwner(
			{
				ownerType: "USER",
				ownerId: userId,
				parentJobId,
				sourceAssetId,
			},
			db,
		),
	getRouteGraphOptions: () => getCurrentExecutableRouteGraphOptions(),
	createAdapter: () => createTextModerationAdapter(process.env),
	persistApproved: (input) => createModeratedGenerationQuoteTransaction(input, db),
	recordDenied: (evidence, context) => recordBlockedPromptAttempt(evidence, context, db),
};

export async function createQuoteForUser(
	userId: string,
	input: {
		productKey: CurrentEzPicProductKey;
		fundingSource?: GenerationFundingSource;
		input: MediaModelInput;
		parentJobId?: string;
		temporaryReferenceToken?: string;
	},
	dependencies: CreateQuoteDependencies = defaultDependencies,
	submission?: {
		quoteId: string;
		fingerprint: string;
		expectedCredits: string;
		rateLimitReceipt?: GenerationRateLimitReceipt;
		rateLimitAction?: "media:generation" | "media:quote";
		/** The server's merged-submit consumer persists this quote with the job. */
		deferPersistence?: boolean;
	},
	timing: FlowTiming = createFlowTiming(),
): Promise<CreatedGenerationQuote> {
	const temporaryReference = input.temporaryReferenceToken
		? verifyTemporaryReference(
				input.temporaryReferenceToken,
				userId,
				input.input.kind === "image-to-image" ? input.input.sourceAssetId : "",
				dependencies.now(),
			)
		: undefined;
	if (temporaryReference && input.parentJobId) throw new Error("TEMPORARY_REFERENCE_INVALID");
	const editContext = await timing.measure("admission.edit-context", () =>
		freezeImageEditContext(userId, input, dependencies),
	);
	const routeGraphOptions = await timing.measure("admission.config", async () =>
		dependencies.getRouteGraphOptions?.(),
	);
	const quote = buildMediaQuote(input, routeGraphOptions);
	if (submission && quote.credits.toString() !== submission.expectedCredits)
		throw new Error("PRICE_CHANGED");
	const selection = dependencies.createAdapter();
	const eligibility = timing.measure("admission.eligibility", () =>
		dependencies.assertAllowed({
			// A merged submission includes its quote; standalone previews have their own flood guard.
			rateLimitAction:
				submission?.rateLimitAction ?? (submission ? "media:generation" : "media:quote"),
			rateLimitReceipt: submission?.rateLimitReceipt,
			userId,
			fundingSource: input.fundingSource,
			imagePassBenefitPolicy: quote.pricingSnapshot.imagePassBenefitPolicy,
			productKey: input.productKey,
			credits: quote.credits,
			costMicros: quote.costMicros,
			input: input.input,
			temporaryReference,
			routeGraphOptions,
		}),
	);
	// Parallel external review is permitted only after the request's flood guard.
	// Standalone legacy callers still finish authorization before contacting SeeAPI.
	if (!submission?.rateLimitReceipt) await eligibility;
	const quoteInput = {
		...(submission ? { quoteId: submission.quoteId } : {}),
		ownerType: "USER" as const,
		ownerId: userId,
		submittedByUserId: userId,
		productKey: input.productKey,
		catalogVersion: quote.catalogVersion,
		pricingVersion: quote.pricingVersion,
		credits: quote.credits,
		costMicros: quote.costMicros,
		inputSnapshot: {
			...input.input,
			...(submission ? { submissionFingerprint: submission.fingerprint } : {}),
			...(editContext ? { editContext } : {}),
			...(temporaryReference ? { temporaryReference } : {}),
		},
		pricingSnapshot: quote.pricingSnapshot,
		expiresAt: new Date(dependencies.now().getTime() + 10 * 60_000),
	};
	let preparedQuote: CreateModeratedGenerationQuoteInput | undefined;
	const moderated = moderateQuoteInput(quoteInput, {
		provider: selection.provider,
		moderateText: (moderationInput) =>
			timing.measure("admission.waffo", () => selection.adapter.moderateText(moderationInput)),
		persistApproved: async (moderation) => {
			await eligibility;
			if (submission?.deferPersistence && routeGraphOptions) {
				preparedQuote = { ...quoteInput, moderation };
				return Promise.resolve({ ...quoteInput, id: submission.quoteId });
			}
			return timing.measure("admission.quote.transaction", () =>
				dependencies.persistApproved({ ...quoteInput, moderation }),
			);
		},
		recordDenied: (evidence) =>
			dependencies.recordDenied(evidence, {
				userId,
				prompt: input.input.prompt,
				productKey: input.productKey,
				sourceAssetId: imageEditSourceAssetId(input.input),
			}),
	});
	// Drain both branches before the request-owned database client is released.
	const [eligibilityResult, moderationResult] = await Promise.allSettled([eligibility, moderated]);
	if (eligibilityResult.status === "rejected") throw eligibilityResult.reason;
	if (moderationResult.status === "rejected") throw moderationResult.reason;
	const created = moderationResult.value;
	return {
		...created,
		pricingSnapshot: quote.pricingSnapshot,
		fundingSource: input.fundingSource ?? "CREDITS",
		imagePassUnits: input.fundingSource === "IMAGE_PASS" ? 1 : 0,
		...(submission && routeGraphOptions
			? {
					admission: {
						ownerId: userId,
						quote: { ...quoteInput, id: created.id },
						routeGraphOptions,
						...(preparedQuote ? { preparedQuote } : {}),
					},
				}
			: {}),
	};
}

async function freezeImageEditContext(
	userId: string,
	input: { productKey: CurrentEzPicProductKey; input: MediaModelInput; parentJobId?: string },
	dependencies: CreateQuoteDependencies,
) {
	const sourceAssetId = imageEditSourceAssetId(input.input);
	if (!sourceAssetId || !isImageEditProduct(input.productKey)) {
		if (input.parentJobId) throw new Error("NOT_FOUND");
		return null;
	}
	if (!input.parentJobId) {
		return { kind: "ROOT" as const, rootAssetId: sourceAssetId };
	}
	const eligible = await dependencies.findEligibleEditParent?.(
		userId,
		input.parentJobId,
		sourceAssetId,
	);
	if (!eligible) throw new Error("NOT_FOUND");
	return {
		kind: "CHILD" as const,
		parentJobId: eligible.parentJobId,
		editSessionId: eligible.editSessionId,
		sourceAssetId: eligible.sourceAssetId,
	};
}

function imageEditSourceAssetId(input: MediaModelInput): string | null {
	return input.kind === "image-to-image" ? input.sourceAssetId : null;
}

function isImageEditProduct(productKey: CurrentEzPicProductKey): boolean {
	return EZPIC_PRODUCT_KEYS.includes(productKey);
}

export const preparableQuoteInputSchema = createQuoteInputSchema.safeExtend({
	preparation: z
		.object({
			idempotencyKey: createGenerationInputSchema.shape.idempotencyKey,
			expectedCredits: z.string().regex(/^[1-9]\d{0,9}$/),
		})
		.optional(),
});

/** Reuse the ordinary persisted quote; preparation never creates a job or reserves credits. */
export async function prepareGenerationQuoteForUser(
	userId: string,
	input: z.infer<typeof preparableQuoteInputSchema> & {
		preparation: { idempotencyKey: string; expectedCredits: string };
	},
	dependencies = {
		findQuote: (owner: string, id: string) => findGenerationSubmissionQuote(owner, id, db),
		createQuote: createQuoteForUser,
		enforceRateLimit: enforceMediaRateLimit,
	},
	timing: FlowTiming = createFlowTiming(),
) {
	const receipt = await createGenerationRateLimitReceipt(
		userId,
		dependencies.enforceRateLimit,
		"media:quote",
	);
	const { quoteId, fingerprint } = generationSubmissionIdentity(userId, {
		...input,
		...input.preparation,
	});
	const reuse = (quote: NonNullable<Awaited<ReturnType<typeof dependencies.findQuote>>>) => {
		assertMatchingSubmission(quote, fingerprint, input.preparation.idempotencyKey);
		if (!quote.job && quote.expiresAt <= new Date()) throw new Error("QUOTE_EXPIRED");
		return {
			...quote,
			fundingSource: input.fundingSource ?? "CREDITS",
			imagePassUnits: input.fundingSource === "IMAGE_PASS" ? 1 : 0,
		};
	};
	const existing = await dependencies.findQuote(userId, quoteId);
	if (existing) return reuse(existing);
	try {
		return await dependencies.createQuote(
			userId,
			input,
			undefined,
			{
				quoteId,
				fingerprint,
				expectedCredits: input.preparation.expectedCredits,
				rateLimitReceipt: receipt,
				rateLimitAction: "media:quote",
			},
			timing,
		);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
			const winner = await dependencies.findQuote(userId, quoteId);
			if (winner) return reuse(winner);
		}
		throw error;
	}
}

export const createQuote = protectedProcedure
	.route({ method: "POST", path: "/media/quotes", tags: ["Media"] })
	.input(preparableQuoteInputSchema)
	.handler(async ({ context: { user, requestId }, input }) => {
		try {
			const timing = createFlowTiming({ requestId });
			const created = input.preparation
				? await prepareGenerationQuoteForUser(
						user.id,
						{ ...input, preparation: input.preparation },
						undefined,
						timing,
					)
				: await createQuoteForUser(user.id, input, undefined, undefined, timing);
			return {
				fundingSource: created.fundingSource,
				imagePassUnits: created.imagePassUnits,
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
