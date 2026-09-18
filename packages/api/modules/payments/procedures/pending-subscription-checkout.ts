import { ORPCError } from "@orpc/server";
import {
	getPaymentCheckoutIntentForOwner,
	getPendingCheckoutForOwner,
	requestCheckoutRecovery,
	checkoutRecoveryView,
	checkoutRecoveryStatusSchema,
	readCheckoutRecovery,
	type RecoverableCheckout,
} from "@repo/database";
import { db } from "@repo/database/client";
import { dispatchJob } from "@repo/jobs/orchestration/client";
import { assertCheckoutRecoveryScope, getPaymentProvider } from "@repo/payments";
import { config as paymentsConfig } from "@repo/payments/config";
import { z } from "zod";

import { protectedProcedure } from "../../../orpc/procedures";
import { verifyOrganizationBillingManagement } from "../../organizations/lib/membership";

const inputSchema = z.object({ checkoutIntentId: z.string().min(1).max(128) }).strict();
const viewSchema = z.object({
	id: z.string(),
	provider: z.enum(["paypal", "waffo"]),
	planId: z.string(),
	interval: z.string(),
	status: checkoutRecoveryStatusSchema,
	canResume: z.boolean(),
	canChange: z.boolean(),
	waitUntil: z.string().nullable(),
	checkedAt: z.string().nullable(),
});
async function ownerFor(userId: string, organizationId: string | null | undefined) {
	if (paymentsConfig.billingAttachedTo === "organization") {
		if (!organizationId || !(await verifyOrganizationBillingManagement(organizationId, userId)))
			throw new ORPCError("FORBIDDEN");
		return { ownerType: "ORGANIZATION" as const, ownerId: organizationId };
	}
	return { ownerType: "USER" as const, ownerId: userId };
}

export const getPendingSubscriptionCheckout = protectedProcedure
	.route({
		method: "GET",
		path: "/payments/pending-subscription-checkout",
		tags: ["Payments"],
		summary: "Read owned unfinished subscription checkout status",
	})
	.input(z.object({}).strict())
	.output(viewSchema.nullable())
	.handler(async ({ context: { user, session } }) => {
		const pending = await getPendingCheckoutForOwner(
			await ownerFor(user.id, session.activeOrganizationId),
			db,
		);
		return pending ? checkoutRecoveryView(pending) : null;
	});

export async function wakeCheckoutRecovery(intent: RecoverableCheckout) {
	if (intent.status === "CANCELED" || intent.status === "COMPLETED") return;
	const state = readCheckoutRecovery(intent.checkoutRecovery);
	if (!state.sequence || !["CHECKING", "ACTIVATING"].includes(state.status)) return;
	try {
		await dispatchJob(
			"media-recover-subscription-checkout",
			{ checkoutIntentId: intent.id, sequence: state.sequence },
			{ idempotencyKey: `checkout-recovery:${intent.id}:${state.sequence}` },
		);
	} catch {
		/* The persisted Outbox is authoritative when immediate dispatch is unavailable. */
	}
}

async function request(
	input: z.infer<typeof inputSchema>,
	userId: string,
	organizationId: string | null | undefined,
	cancel: boolean,
) {
	const owner = await ownerFor(userId, organizationId);
	try {
		const intent = await requestCheckoutRecovery(
			{ ...owner, id: input.checkoutIntentId, actorUserId: userId, cancel },
			db,
		);
		await wakeCheckoutRecovery(intent);
		return checkoutRecoveryView(intent);
	} catch (error) {
		if (error instanceof Error && error.message === "CHECKOUT_NOT_FOUND")
			throw new ORPCError("NOT_FOUND");
		throw error;
	}
}

export const refreshPendingSubscriptionCheckout = protectedProcedure
	.route({
		method: "POST",
		path: "/payments/pending-subscription-checkout/refresh",
		tags: ["Payments"],
		summary: "Request durable provider status inspection",
	})
	.input(inputSchema)
	.output(viewSchema)
	.handler(({ input, context: { user, session } }) =>
		request(input, user.id, session.activeOrganizationId, false),
	);

export const cancelPendingSubscriptionCheckout = protectedProcedure
	.route({
		method: "POST",
		path: "/payments/pending-subscription-checkout/cancel",
		tags: ["Payments"],
		summary: "Abandon an unactivated checkout or request confirmed provider closure",
	})
	.input(inputSchema)
	.output(viewSchema)
	.handler(({ input, context: { user, session } }) =>
		request(input, user.id, session.activeOrganizationId, true),
	);

export async function resumableCheckoutLink(intent: RecoverableCheckout): Promise<string> {
	if (!checkoutRecoveryView(intent).canResume || !intent.providerCheckoutUrl)
		throw new ORPCError("CONFLICT", { message: "PAYMENT_CHECKOUT_INTENT_REPLAY_UNSAFE" });
	assertCheckoutRecoveryScope(intent, process.env);
	const adapter = getPaymentProvider(intent.provider);
	if (intent.provider === "waffo" && !adapter?.resumeSubscriptionCheckout)
		throw new ORPCError("SERVICE_UNAVAILABLE");
	return adapter?.resumeSubscriptionCheckout
		? adapter.resumeSubscriptionCheckout({
				checkoutUrl: intent.providerCheckoutUrl,
				priceId: intent.billingPlan.providerPriceId,
				ownerType: intent.ownerType,
				ownerId: intent.ownerId,
			})
		: intent.providerCheckoutUrl;
}

export const resumePendingSubscriptionCheckout = protectedProcedure
	.route({
		method: "POST",
		path: "/payments/pending-subscription-checkout/resume",
		tags: ["Payments"],
		summary: "Resume the same checkout, renewing authentication when necessary",
	})
	.input(inputSchema)
	.output(z.object({ checkoutLink: z.url() }))
	.handler(async ({ input, context: { user, session } }) => {
		const owner = await ownerFor(user.id, session.activeOrganizationId);
		const intent = await getPaymentCheckoutIntentForOwner(
			{ ...owner, intentId: input.checkoutIntentId },
			db,
		);
		if (!intent || intent.productKind !== "PLAN") throw new ORPCError("NOT_FOUND");
		const checkoutLink = await resumableCheckoutLink(intent);
		const current = await getPaymentCheckoutIntentForOwner(
			{ ...owner, intentId: input.checkoutIntentId },
			db,
		);
		if (!current || !checkoutRecoveryView(current).canResume) throw new ORPCError("CONFLICT");
		return { checkoutLink };
	});
