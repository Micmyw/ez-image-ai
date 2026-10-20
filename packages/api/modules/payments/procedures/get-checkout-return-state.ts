import { ORPCError } from "@orpc/client";
import { resolvePlanEntitlement } from "@repo/config";
import { getPaymentCheckoutIntentForOwner, readCheckoutRecovery } from "@repo/database";
import { db } from "@repo/database/client";
import { z } from "zod";

import { protectedProcedure } from "../../../orpc/procedures";

const checkoutReturnStateSchema = z.object({
	status: z.enum(["PENDING", "ACTIVE", "PAST_DUE", "REVIEW", "EXPIRED", "CANCELED"]),
	planId: z.enum(["creator", "ultimate", "studio"]).nullable(),
	paidThrough: z.date().nullable(),
});
type CheckoutReturnState = z.infer<typeof checkoutReturnStateSchema>;
const pending: CheckoutReturnState = { status: "PENDING", planId: null, paidThrough: null };

export const getCheckoutReturnState = protectedProcedure
	.route({
		method: "GET",
		path: "/payments/checkout-return-state",
		tags: ["Payments"],
		summary: "Read internal checkout processing state",
	})
	.input(
		z.object({
			organizationId: z.string().optional(),
			expectedPlanId: z.enum(["creator", "ultimate", "studio"]),
			checkoutIntentId: z.string().trim().min(1).max(128).optional(),
		}),
	)
	.output(checkoutReturnStateSchema)
	.handler(async ({ input, context: { user } }) => {
		assertCheckoutReturnOwnerScope(input.organizationId);
		const ownerType = "USER";
		const ownerId = user.id;
		// A legacy return cannot identify this purchase from an existing same-plan subscription.
		if (!input.checkoutIntentId) return pending;
		const intent = await getPaymentCheckoutIntentForOwner(
			{ intentId: input.checkoutIntentId, ownerType, ownerId },
			db,
		);
		if (
			!intent ||
			intent.ownerType !== ownerType ||
			intent.ownerId !== ownerId ||
			intent.productKind !== "PLAN" ||
			(intent.provider !== "paypal" && intent.provider !== "waffo") ||
			intent.billingPlan.productKind !== "PLAN" ||
			intent.billingPlan.provider !== intent.provider ||
			intent.billingPlan.id !== intent.billingPlanId ||
			intent.planKey !== input.expectedPlanId ||
			intent.billingPlan.name !== input.expectedPlanId
		) {
			throw new ORPCError("NOT_FOUND");
		}
		if (intent.status === "REVIEW" || intent.status === "EXPIRED" || intent.status === "CANCELED") {
			return { status: intent.status, planId: null, paidThrough: null };
		}
		if (intent.status !== "COMPLETED") {
			return readCheckoutRecovery(intent.checkoutRecovery).status === "REVIEW"
				? { status: "REVIEW", planId: null, paidThrough: null }
				: pending;
		}
		const providerSubscriptionId =
			intent.provider === "paypal" ? intent.providerSessionId : intent.providerOrderId;
		if (!providerSubscriptionId) return pending;
		const now = new Date();
		const subscription = await db.subscription.findFirst({
			where: {
				ownerType,
				ownerId,
				provider: intent.provider,
				providerSubscriptionId,
				planId: intent.billingPlanId,
				refundTerminationRequestedAt: null,
			},
			include: {
				plan: true,
				periods: {
					where: {
						startsAt: { lte: now },
						paidAmount: { gt: 0n },
						status: { not: "VOID" },
					},
					orderBy: { startsAt: "desc" },
				},
			},
		});
		if (
			!subscription ||
			subscription.ownerType !== ownerType ||
			subscription.ownerId !== ownerId ||
			subscription.provider !== intent.provider ||
			subscription.providerSubscriptionId !== providerSubscriptionId ||
			subscription.planId !== intent.billingPlanId
		)
			return pending;
		// Provider activation can complete an intent before its payment receipt arrives.
		return resolveCheckoutReturnState(subscription, input.expectedPlanId, now);
	});

export function assertCheckoutReturnOwnerScope(organizationId: string | undefined): void {
	if (organizationId) throw new ORPCError("FORBIDDEN");
}

export function resolveCheckoutReturnState(
	subscription: {
		status: string;
		graceEndsAt: Date | null;
		plan: { metadata: unknown; name: string };
		periods: Array<{
			startsAt: Date;
			endsAt: Date;
			paidAmount: bigint;
			refundedAmount: bigint;
			status: string;
		}>;
		currentPeriodStart: Date | null;
		currentPeriodEnd: Date | null;
		refundTerminationRequestedAt?: Date | null;
	} | null,
	expectedPlanId: "creator" | "ultimate" | "studio",
	now = new Date(),
): CheckoutReturnState {
	const planId = subscription
		? resolvePlanEntitlement(subscription.plan.metadata, subscription.plan.name).id
		: null;
	const paidPeriods =
		subscription?.periods.filter(
			(period) => period.status !== "VOID" && period.paidAmount > 0n && period.startsAt <= now,
		) ?? [];
	// Keep refunded payments in this selection so grace cannot fall back to an
	// older receipt. Input order is not a business guarantee.
	const latestPaidPeriod = paidPeriods.reduce<(typeof paidPeriods)[number] | undefined>(
		(latest, period) => (!latest || period.startsAt > latest.startsAt ? period : latest),
		undefined,
	);
	const effective =
		subscription &&
		!subscription.refundTerminationRequestedAt &&
		((["ACTIVE", "CANCELED"].includes(subscription.status) &&
			subscription.currentPeriodStart &&
			subscription.currentPeriodStart <= now &&
			subscription.currentPeriodEnd &&
			subscription.currentPeriodEnd > now &&
			paidPeriods.some(
				(period) => period.endsAt > now && period.paidAmount > period.refundedAmount,
			)) ||
			(subscription.status === "PAST_DUE" &&
				subscription.graceEndsAt &&
				subscription.graceEndsAt > now &&
				latestPaidPeriod &&
				latestPaidPeriod.paidAmount > latestPaidPeriod.refundedAmount));
	if (!subscription || planId !== expectedPlanId || !effective) {
		return pending;
	}
	return {
		status: subscription.status === "PAST_DUE" ? "PAST_DUE" : "ACTIVE",
		planId: expectedPlanId,
		paidThrough: subscription.currentPeriodEnd,
	};
}
