import { ORPCError } from "@orpc/server";
import { getPlanEntitlement, resolvePlanEntitlement } from "@repo/config";
import { getOrganizationById, getOrganizationMembership } from "@repo/database";
import { db } from "@repo/database/client";
import { logger } from "@repo/logs";
import {
	createCheckoutLink as createCheckoutLinkFn,
	findPriceByPlanId,
	getCustomerIdFromEntity,
	getProviderPriceIdByPlanId,
	isPlanId,
} from "@repo/payments";
import { getBaseUrl } from "@repo/utils";
import { z } from "zod";

import { localeMiddleware } from "../../../orpc/middleware/locale-middleware";
import { protectedProcedure } from "../../../orpc/procedures";
import { paymentRedirectUrlSchema } from "../redirect-url";

export const createCheckoutLink = protectedProcedure
	.use(localeMiddleware)
	.route({
		method: "POST",
		path: "/payments/create-checkout-link",
		tags: ["Payments"],
		summary: "Create checkout link",
		description: "Creates a checkout link for a one-time or subscription product",
	})
	.input(
		z.object({
			planId: z.string(),
			type: z.enum(["one-time", "subscription"]),
			interval: z.enum(["month", "year"]).optional(),
			redirectUrl: paymentRedirectUrlSchema,
			organizationId: z.string().optional(),
		}),
	)
	.output(
		z.object({
			checkoutLink: z.url(),
		}),
	)
	.handler(
		async ({
			input: { planId, redirectUrl, type, interval, organizationId },
			context: { user },
		}) => {
			const safeRedirectUrl = resolveCheckoutRedirectUrl(redirectUrl);

			const normalizedType = type === "subscription" ? "subscription" : "one-time";
			if (normalizedType !== "subscription") {
				throw new ORPCError("BAD_REQUEST");
			}
			if (!isPlanId(planId)) {
				throw new ORPCError("NOT_FOUND");
			}
			if (planId !== "creator" && planId !== "studio") {
				throw new ORPCError("NOT_FOUND");
			}

			const price = findPriceByPlanId(planId, {
				type: "subscription",
				interval,
			});
			const priceId = getProviderPriceIdByPlanId(planId, {
				type: normalizedType,
				interval,
			});

			if (!price || !priceId) {
				throw new ORPCError("NOT_FOUND");
			}
			const customerId = await resolveCheckoutCustomerId({ organizationId, userId: user.id });

			const trialPeriodDays =
				price && "trialPeriodDays" in price ? price.trialPeriodDays : undefined;

			const organization = organizationId ? await getOrganizationById(organizationId) : undefined;

			if (organization === null) {
				throw new ORPCError("NOT_FOUND");
			}
			const billingPlan = await db.billingPlan.findUnique({
				where: { provider_providerPriceId: { provider: "stripe", providerPriceId: priceId } },
			});
			const entitlement = getPlanEntitlement(planId);
			if (
				!billingPlan?.active ||
				resolvePlanEntitlement(billingPlan.metadata, billingPlan.name).id !== planId ||
				billingPlan.creditsPerPeriod !== BigInt(entitlement.monthlyCredits) ||
				billingPlan.priceMicros !== BigInt(Math.round(price.amount * 1_000_000)) ||
				billingPlan.currency !== price.currency
			) {
				throw new ORPCError("NOT_FOUND");
			}

			const seats =
				organization && price && "seatBased" in price && price.seatBased
					? organization.members.length
					: undefined;

			try {
				const checkoutLink = await createCheckoutLinkFn({
					type: "subscription",
					priceId,
					billingPlanId: billingPlan.id,
					planKey: planId,
					ownerType: organizationId ? "ORGANIZATION" : "USER",
					ownerId: organizationId ?? user.id,
					submittedByUserId: user.id,
					organizationId,
					userId: organizationId ? undefined : user.id,
					email: user.email,
					name: user.name ?? "",
					redirectUrl: safeRedirectUrl,
					trialPeriodDays,
					seats,
					customerId: customerId ?? undefined,
				});

				if (!checkoutLink) {
					throw new ORPCError("INTERNAL_SERVER_ERROR");
				}

				return { checkoutLink };
			} catch (error) {
				logger.error(error);
				throw new ORPCError("INTERNAL_SERVER_ERROR");
			}
		},
	);

export function assertOrganizationCheckoutOwner(role: string | undefined): void {
	if (role !== "owner") throw new ORPCError("FORBIDDEN");
}

interface CheckoutCustomerDependencies {
	getMembership(organizationId: string, userId: string): Promise<{ role: string } | null>;
	getCustomerId(owner: { organizationId: string } | { userId: string }): Promise<string | null>;
}

export async function resolveCheckoutCustomerId(
	input: { organizationId?: string; userId: string },
	dependencies: CheckoutCustomerDependencies = {
		getMembership: getOrganizationMembership,
		getCustomerId: getCustomerIdFromEntity,
	},
): Promise<string | null> {
	if (!input.organizationId) return dependencies.getCustomerId({ userId: input.userId });
	const membership = await dependencies.getMembership(input.organizationId, input.userId);
	assertOrganizationCheckoutOwner(membership?.role);
	return dependencies.getCustomerId({ organizationId: input.organizationId });
}

export function resolveCheckoutRedirectUrl(
	redirectUrl: string | undefined,
	environment: NodeJS.ProcessEnv = process.env,
): string {
	const saasUrl = getBaseUrl(environment.NEXT_PUBLIC_SAAS_URL, 3000);
	const allowedOrigins = new Set([new URL(saasUrl).origin]);

	let parsed: URL;
	try {
		parsed = new URL(redirectUrl ?? "/checkout-return", saasUrl);
	} catch {
		throw new ORPCError("BAD_REQUEST");
	}
	if (!allowedOrigins.has(parsed.origin)) throw new ORPCError("BAD_REQUEST");
	return parsed.toString();
}
