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
			expectedPlanId: z.enum(["creator", "studio"]),
		}),
	)
	.handler(async ({ input, context: { user } }) => {
		assertCheckoutReturnOwnerScope(input.organizationId);
		const ownerType = "USER";
		const ownerId = user.id;
		const subscription = await db.subscription.findFirst({
			where: { ownerType, ownerId },
			include: {
				plan: true,
				periods: { orderBy: { startsAt: "desc" }, take: 1 },
			},
			orderBy: { updatedAt: "desc" },
		});
		return resolveCheckoutReturnState(subscription, input.expectedPlanId);
	});

export function assertCheckoutReturnOwnerScope(organizationId: string | undefined): void {
	if (organizationId) throw new ORPCError("FORBIDDEN");
}

export function resolveCheckoutReturnState(
	subscription: {
		status: string;
		graceEndsAt: Date | null;
		plan: { metadata: unknown; name: string };
		periods: Array<{ endsAt: Date }>;
		currentPeriodEnd: Date | null;
	} | null,
	expectedPlanId: "creator" | "studio",
	now = new Date(),
) {
	const planId = subscription
		? resolvePlanEntitlement(subscription.plan.metadata, subscription.plan.name).id
		: null;
	const effective =
		subscription?.status === "ACTIVE" ||
		(subscription?.status === "PAST_DUE" &&
			Boolean(subscription.graceEndsAt && subscription.graceEndsAt > now));
	if (!subscription || planId !== expectedPlanId || !effective) {
		return { status: "PENDING", planId: null, paidThrough: null };
	}
	return {
		status: subscription.status,
		planId,
		paidThrough: subscription.periods[0]?.endsAt ?? subscription.currentPeriodEnd ?? null,
	};
}
