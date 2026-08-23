import { ORPCError } from "@orpc/server";
import { getOrganizationMembership, getPurchaseById } from "@repo/database";
import { logger } from "@repo/logs";
import { createCustomerPortalLink as createCustomerPortalLinkFn } from "@repo/payments";
import { z } from "zod";

import { localeMiddleware } from "../../../orpc/middleware/locale-middleware";
import { protectedProcedure } from "../../../orpc/procedures";
import { paymentRedirectUrlSchema } from "../redirect-url";

export const createCustomerPortalLink = protectedProcedure
	.use(localeMiddleware)
	.route({
		method: "POST",
		path: "/payments/create-customer-portal-link",
		tags: ["Payments"],
		summary: "Create customer portal link",
		description:
			"Creates a customer portal link for the customer or team. If a purchase is provided, the link will be created for the customer of the purchase.",
	})
	.input(
		z.object({
			purchaseId: z.string(),
			redirectUrl: paymentRedirectUrlSchema,
		}),
	)
	.output(
		z.object({
			customerPortalLink: z.url(),
		}),
	)
	.handler(async ({ input: { purchaseId, redirectUrl }, context: { user } }) => {
		const purchase = await getPurchaseById(purchaseId);

		if (!purchase) {
			throw new ORPCError("NOT_FOUND");
		}

		const hasOrganizationOwner = purchase.organizationId !== null;
		const hasUserOwner = purchase.userId !== null;
		if (hasOrganizationOwner === hasUserOwner) {
			throw new ORPCError("NOT_FOUND");
		}

		if (hasOrganizationOwner) {
			const userOrganizationMembership = await getOrganizationMembership(
				purchase.organizationId!,
				user.id,
			);
			if (userOrganizationMembership?.role !== "owner") {
				throw new ORPCError("NOT_FOUND");
			}
		}

		if (hasUserOwner && purchase.userId !== user.id) {
			throw new ORPCError("NOT_FOUND");
		}

		try {
			const customerPortalLink = await createCustomerPortalLinkFn({
				subscriptionId: purchase.subscriptionId ?? undefined,
				customerId: purchase.customerId,
				redirectUrl,
			});

			if (!customerPortalLink) {
				throw new ORPCError("INTERNAL_SERVER_ERROR");
			}

			return { customerPortalLink };
		} catch (error) {
			logger.error("Could not create customer portal link", error);
			throw new ORPCError("INTERNAL_SERVER_ERROR");
		}
	});
