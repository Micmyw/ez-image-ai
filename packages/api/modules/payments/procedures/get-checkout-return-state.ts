import { ORPCError } from "@orpc/client";
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
	.input(z.object({ organizationId: z.string().optional() }))
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
		return {
			status: subscription?.status ?? "PENDING",
			planId: subscription?.plan.metadata && jsonPlanId(subscription.plan.metadata),
			paidThrough: subscription?.periods[0]?.endsAt ?? subscription?.currentPeriodEnd ?? null,
		};
	});

export function assertCheckoutReturnOwnerScope(organizationId: string | undefined): void {
	if (organizationId) throw new ORPCError("FORBIDDEN");
}

function jsonPlanId(value: unknown): string | null {
	return value && typeof value === "object" && !Array.isArray(value) && "planId" in value
		? String(value.planId)
		: null;
}
