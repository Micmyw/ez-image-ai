import { ORPCError } from "@orpc/server";
import {
	findEffectivePaidSubscription,
	getPurchasesByOrganizationId,
	getPurchasesByUserId,
	PurchaseSchema,
} from "@repo/database";
import { db } from "@repo/database/client";
import {
	getPlanIdByProviderPriceId,
	getPlanPriceByProviderPriceId,
	resolvePaymentProvider,
} from "@repo/payments";
import { z } from "zod";

import { protectedProcedure } from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

export const listPurchases = protectedProcedure
	.route({
		method: "GET",
		path: "/payments/purchases",
		tags: ["Payments"],
		summary: "Get purchases",
		description: "Get all purchases of the current user or the provided organization",
	})
	.input(
		z.object({
			organizationId: z.string().optional(),
		}),
	)
	.output(
		z.array(
			PurchaseSchema.extend({
				planId: z.string().nullable(),
				isEffectiveSubscription: z.boolean().optional(),
				subscription: z
					.object({
						cancelAtPeriodEnd: z.boolean(),
						currentPeriodEnd: z.date().nullable(),
						refundTermination: z.enum(["PENDING", "RETRYING", "COMPLETED"]).nullable(),
						cancellation: z.enum(["PENDING", "RETRYING", "CONFIRMED"]).nullable(),
					})
					.nullable(),
				providerCapabilities: z.object({
					portal: z.boolean(),
					cancellation: z.boolean(),
					seatUpdates: z.boolean(),
				}),
				planPrice: z
					.discriminatedUnion("type", [
						z.object({
							type: z.literal("one-time"),
							amount: z.number(),
							currency: z.string(),
							priceId: z.string().optional(),
						}),
						z.object({
							type: z.literal("subscription"),
							amount: z.number(),
							currency: z.string(),
							priceId: z.string().optional(),
							interval: z.enum(["month", "year"]),
							seatBased: z.boolean().optional(),
							trialPeriodDays: z.number().int().nonnegative().optional(),
						}),
					])
					.nullable(),
			}),
		),
	)
	.handler(async ({ input: { organizationId }, context: { user } }) => {
		if (organizationId) {
			const membership = await verifyOrganizationMembership(organizationId, user.id);

			if (!membership) {
				throw new ORPCError("FORBIDDEN");
			}
		}

		const purchases = organizationId
			? await getPurchasesByOrganizationId(organizationId)
			: await getPurchasesByUserId(user.id);
		const effective = await findEffectivePaidSubscription(
			{
				ownerType: organizationId ? "ORGANIZATION" : "USER",
				ownerId: organizationId ?? user.id,
			},
			db,
		);

		return purchases.map((purchase) => {
			const { mediaSubscription: _mediaSubscription, ...publicPurchase } = purchase;
			const isPlanPurchase = purchase.productKind === "PLAN";
			const persistedPlan = isPlanPurchase ? resolvePersistedSubscriptionPlan(purchase) : null;

			return {
				...publicPurchase,
				...(persistedPlan
					? {
							status: purchase.mediaSubscription!.status.toLowerCase(),
							isEffectiveSubscription: purchase.mediaSubscription!.id === effective?.id,
						}
					: {}),
				subscription: persistedPlan?.subscription ?? null,
				planId: isPlanPurchase
					? (persistedPlan?.planId ??
						getPlanIdByProviderPriceId(purchase.provider, purchase.priceId))
					: null,
				planPrice: isPlanPurchase
					? (persistedPlan?.price ??
						getPlanPriceByProviderPriceId(purchase.provider, purchase.priceId)?.price ??
						null)
					: null,
				providerCapabilities: managementCapabilities(purchase.provider),
			};
		});
	});

interface PurchaseWithSubscriptionPlan {
	type: string;
	productKind: "PLAN" | "CREDIT_PACK";
	provider: string;
	userId: string | null;
	organizationId: string | null;
	mediaSubscription: {
		ownerType: "USER" | "ORGANIZATION";
		ownerId: string;
		provider: string;
		cancelAtPeriodEnd: boolean;
		cancellationRequestedAt?: Date | null;
		renewalDisabledAt?: Date | null;
		cancellationError?: string | null;
		currentPeriodEnd: Date | null;
		refundTerminationRequestedAt?: Date | null;
		refundTerminatedAt?: Date | null;
		refundTerminationError?: string | null;
		plan: {
			provider: string;
			priceMicros: bigint;
			currency: string;
			metadata: unknown;
		};
	} | null;
}

function resolvePersistedSubscriptionPlan(purchase: PurchaseWithSubscriptionPlan): {
	planId: "creator" | "ultimate" | "studio";
	subscription: {
		cancelAtPeriodEnd: boolean;
		currentPeriodEnd: Date | null;
		refundTermination: "PENDING" | "RETRYING" | "COMPLETED" | null;
		cancellation: "PENDING" | "RETRYING" | "CONFIRMED" | null;
	};
	price: {
		type: "subscription";
		interval: "month" | "year";
		amount: number;
		currency: string;
	};
} | null {
	if (purchase.productKind !== "PLAN" || purchase.type !== "SUBSCRIPTION") return null;
	const subscription = purchase.mediaSubscription;
	const owner =
		purchase.userId && !purchase.organizationId
			? { type: "USER", id: purchase.userId }
			: purchase.organizationId && !purchase.userId
				? { type: "ORGANIZATION", id: purchase.organizationId }
				: null;

	if (
		!subscription ||
		!owner ||
		subscription.ownerType !== owner.type ||
		subscription.ownerId !== owner.id ||
		subscription.provider !== purchase.provider ||
		subscription.plan.provider !== purchase.provider
	) {
		return null;
	}

	const planId = metadataString(subscription.plan.metadata, "planId");
	const interval = metadataString(subscription.plan.metadata, "interval");
	const priceMicros = Number(subscription.plan.priceMicros);
	if (
		(planId !== "creator" && planId !== "ultimate" && planId !== "studio") ||
		(interval !== "month" && interval !== "year") ||
		!Number.isSafeInteger(priceMicros)
	) {
		return null;
	}

	return {
		planId,
		subscription: {
			cancelAtPeriodEnd: subscription.cancelAtPeriodEnd ?? false,
			currentPeriodEnd: subscription.currentPeriodEnd ?? null,
			cancellation: subscription.renewalDisabledAt
				? "CONFIRMED"
				: subscription.cancellationRequestedAt || subscription.cancelAtPeriodEnd
					? subscription.cancellationError
						? "RETRYING"
						: "PENDING"
					: null,
			refundTermination: subscription.refundTerminatedAt
				? "COMPLETED"
				: subscription.refundTerminationRequestedAt
					? subscription.refundTerminationError
						? "RETRYING"
						: "PENDING"
					: null,
		},
		price: {
			type: "subscription" as const,
			interval,
			amount: priceMicros / 1_000_000,
			currency: subscription.plan.currency,
		},
	};
}

function metadataString(value: unknown, key: string): string | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const candidate = (value as Record<string, unknown>)[key];
	return typeof candidate === "string" ? candidate : null;
}

function managementCapabilities(provider: string) {
	const capabilities = resolvePaymentProvider(provider)?.capabilities;
	return {
		portal: capabilities?.portal ?? false,
		cancellation: capabilities?.cancellation ?? false,
		seatUpdates: capabilities?.seatUpdates ?? false,
	};
}
