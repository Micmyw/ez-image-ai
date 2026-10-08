import { listAdminPaymentAttribution } from "@repo/database";
import { checkoutAttributionSchema, parseCheckoutAttribution } from "@repo/utils";
import { z } from "zod";

import { adminProcedure } from "../../../orpc/procedures";

const rowSchema = z.object({
	id: z.string(),
	ownerType: z.enum(["USER", "ORGANIZATION"]).nullable(),
	ownerId: z.string().nullable(),
	productKind: z.enum(["PLAN", "CREDIT_PACK"]),
	provider: z.string(),
	status: z.string().nullable(),
	createdAt: z.string(),
	attribution: checkoutAttributionSchema.nullable(),
});

export const listAdminPaymentAttributionProcedure = adminProcedure
	.route({
		method: "GET",
		path: "/admin/payments/attribution",
		tags: ["Admin", "Payments"],
		summary: "Read registration and checkout attribution for orders",
		description:
			"Read up to 20 recent purchases and checkout intents, or find an exact local order reference. Historical orders retain unknown attribution.",
	})
	.input(
		z
			.object({
				limit: z.number().int().min(1).max(20).default(20),
				reference: z.string().trim().min(1).max(128).optional(),
			})
			.strict(),
	)
	.output(
		z.object({
			purchases: z.array(rowSchema.extend({ type: z.enum(["SUBSCRIPTION", "ONE_TIME"]) })),
			checkouts: z.array(rowSchema.extend({ planKey: z.string(), interval: z.string() })),
		}),
	)
	.handler(async ({ input, context }) => {
		context.responseHeaders?.set("Cache-Control", "private, no-store");
		const result = await listAdminPaymentAttribution(input);
		const origin = process.env.NEXT_PUBLIC_SAAS_URL;
		return {
			purchases: result.purchases.map((purchase) => ({
				id: purchase.id,
				ownerType: purchase.organizationId
					? ("ORGANIZATION" as const)
					: purchase.userId
						? ("USER" as const)
						: null,
				ownerId: purchase.organizationId ?? purchase.userId,
				type: purchase.type,
				productKind: purchase.productKind,
				provider: purchase.provider,
				status: purchase.status,
				createdAt: purchase.createdAt.toISOString(),
				attribution: parseCheckoutAttribution(purchase.attribution, origin),
			})),
			checkouts: result.checkouts.map((checkout) => ({
				id: checkout.id,
				ownerType: checkout.ownerType,
				ownerId: checkout.ownerId,
				productKind: checkout.productKind,
				provider: checkout.provider,
				planKey: checkout.planKey,
				interval: checkout.interval,
				status: checkout.status,
				createdAt: checkout.createdAt.toISOString(),
				attribution: parseCheckoutAttribution(checkout.attribution, origin),
			})),
		};
	});
