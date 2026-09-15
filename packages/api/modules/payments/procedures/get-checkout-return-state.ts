import { ORPCError } from "@orpc/client";
import { resolvePlanEntitlement } from "@repo/config";
import { db } from "@repo/database/client";
import { z } from "zod";

import { protectedProcedure } from "../../../orpc/procedures";

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
		}),
	)
	.handler(async ({ input, context: { user } }) => {
		assertCheckoutReturnOwnerScope(input.organizationId);
		const ownerType = "USER";
		const ownerId = user.id;
		const now = new Date();
		const subscription = await db.subscription.findFirst({
			where: { ownerType, ownerId },
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
			orderBy: { updatedAt: "desc" },
		});
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
	} | null,
	expectedPlanId: "creator" | "ultimate" | "studio",
	now = new Date(),
) {
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
		return { status: "PENDING", planId: null, paidThrough: null };
	}
	return {
		status: subscription.status === "CANCELED" ? "ACTIVE" : subscription.status,
		planId,
		paidThrough: subscription.currentPeriodEnd,
	};
}
