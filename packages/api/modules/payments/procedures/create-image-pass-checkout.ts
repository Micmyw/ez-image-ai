import { ORPCError } from "@orpc/server";
import {
	getImagePassOfferSnapshot,
	isImagePassOfferSnapshot,
	IMAGE_PASS_PUBLIC_OFFER,
} from "@repo/config/image-pass";
import { isImagePassBillingPlan, IMAGE_PASS_PAYPAL_SKU } from "@repo/config/image-pass.server";
import {
	bindPaymentCheckoutIntentSession,
	createPaymentCheckoutIntent,
	getPaymentCheckoutIntentForOwner,
	getPaymentCheckoutIntentForOwnerByIdempotencyKey,
	getPaymentCustomer,
	markPaymentCheckoutIntentProviderCreating,
} from "@repo/database";
import { db } from "@repo/database/client";
import { logger } from "@repo/logs";
import {
	getPaymentProvider,
	isPaymentProviderConfigured,
	isPaymentProviderCheckoutAvailable,
} from "@repo/payments";
import { getBaseUrl } from "@repo/utils";
import { z } from "zod";

import { protectedProcedure } from "../../../orpc/procedures";
import { assertNewBillingEnabled, assertBillingEnvironmentReady } from "../billing-gate";
import { captureCheckoutAttribution, checkoutTriggerInputSchema } from "../checkout-attribution";
import { observeCheckoutOperation } from "../checkout-diagnostics";
import { recoverProviderCreatingCheckout } from "./checkout-recovery";

const imagePassCheckoutProviderSchema = z.literal("paypal");

export const imagePassCheckoutInputSchema = z
	.object({
		provider: imagePassCheckoutProviderSchema,
		attribution: checkoutTriggerInputSchema,
		idempotencyKey: z
			.string()
			.trim()
			.regex(/^\w[\w.:-]{7,127}$/),
	})
	.strict();

export const createImagePassCheckout = protectedProcedure
	.route({
		method: "POST",
		path: "/payments/create-image-pass-checkout",
		tags: ["Payments"],
		summary: "Create a image-pass checkout",
		description: "Creates a server-priced one-time checkout through PayPal",
	})
	.input(imagePassCheckoutInputSchema)
	.output(z.object({ checkoutLink: z.url(), intentId: z.string().min(1) }))
	.handler(async ({ input, context: { session, user, headers } }) => {
		assertNewBillingEnabled();
		await assertBillingEnvironmentReady();
		const { provider, idempotencyKey } = input;
		const packKey = IMAGE_PASS_PUBLIC_OFFER.offerKey;
		if (!isPaymentProviderConfigured(provider)) throw new ORPCError("NOT_FOUND");
		if (!(await isPaymentProviderCheckoutAvailable(provider, { fresh: true })))
			throw new ORPCError("SERVICE_UNAVAILABLE", { message: "PAYMENT_PROVIDER_UNAVAILABLE" });

		const providerDefinition = getPaymentProvider(provider);
		if (!providerDefinition?.capabilities.checkout) throw new ORPCError("NOT_FOUND");
		const owner = await resolveImagePassCheckoutOwner(user.id, session.activeOrganizationId);
		let trustedIntent = await getPaymentCheckoutIntentForOwnerByIdempotencyKey(
			{ ...owner, idempotencyKey },
			db,
		);
		if (trustedIntent) {
			if (!isTrustedImagePassIntent(trustedIntent, provider, packKey, user.id)) {
				throw new ORPCError("CONFLICT");
			}
			if (
				trustedIntent.status === "PROVIDER_PENDING" &&
				trustedIntent.providerSessionId &&
				trustedIntent.providerCheckoutUrl
			) {
				return { checkoutLink: trustedIntent.providerCheckoutUrl, intentId: trustedIntent.id };
			}
			if (trustedIntent.status !== "CREATED" && trustedIntent.status !== "PROVIDER_CREATING") {
				throw new ORPCError("CONFLICT");
			}
		} else {
			const providerProductId = IMAGE_PASS_PAYPAL_SKU;
			if (!providerProductId) throw new ORPCError("NOT_FOUND");
			const billingPlan = await db.billingPlan.findUnique({
				where: {
					provider_providerPriceId: { provider, providerPriceId: providerProductId },
				},
			});
			if (!billingPlan?.active || !isImagePassBillingPlan(billingPlan))
				throw new ORPCError("NOT_FOUND");
			const now = new Date();
			let checkoutIntent;
			try {
				checkoutIntent = await createPaymentCheckoutIntent(
					{
						provider,
						...owner,
						submittedByUserId: user.id,
						billingPlanId: billingPlan.id,
						productKind: "IMAGE_PASS",
						planKey: packKey,
						interval: "one-time",
						idempotencyKey,
						now,
						attribution: await captureCheckoutAttribution(headers, input.attribution, user.id, now),
						imagePassOfferSnapshot: getImagePassOfferSnapshot(),
					},
					db,
				);
			} catch (error) {
				if (isImagePassCheckoutConflict(error)) throw new ORPCError("CONFLICT");
				throw new ORPCError("INTERNAL_SERVER_ERROR");
			}

			if (
				checkoutIntent.intent.status !== "CREATED" &&
				checkoutIntent.intent.status !== "PROVIDER_PENDING"
			) {
				throw new ORPCError("CONFLICT");
			}
			trustedIntent = await getPaymentCheckoutIntentForOwner(
				{ intentId: checkoutIntent.intent.id, ...owner },
				db,
			);
			if (!isTrustedImagePassIntent(trustedIntent, provider, packKey, user.id)) {
				throw new ORPCError("CONFLICT");
			}
			if (
				trustedIntent.status === "PROVIDER_PENDING" &&
				trustedIntent.providerSessionId &&
				trustedIntent.providerCheckoutUrl
			) {
				return { checkoutLink: trustedIntent.providerCheckoutUrl, intentId: trustedIntent.id };
			}
			if (trustedIntent.status !== "CREATED" && trustedIntent.status !== "PROVIDER_CREATING") {
				throw new ORPCError("CONFLICT");
			}
		}

		const providerIntent = trustedIntent;
		const diagnosticIdentity = { intentId: providerIntent.id, actorUserId: user.id };
		const customer = await getPaymentCustomer(provider, owner, db);
		const checkoutOptions = {
			type: "one-time" as const,
			priceId: providerIntent.billingPlan.providerPriceId,
			currency: providerIntent.billingPlan.currency,
			amountMicros: providerIntent.billingPlan.priceMicros,
			description: "EzImageAI 3 successful images",
			billingPlanId: providerIntent.billingPlanId,
			checkoutIntentId: providerIntent.id,
			idempotencyKey: providerIntent.idempotencyKey,
			planKey: providerIntent.planKey,
			...owner,
			submittedByUserId: user.id,
			...(owner.ownerType === "USER"
				? { userId: owner.ownerId }
				: { organizationId: owner.ownerId }),
			email: user.email,
			name: user.name ?? "",
			redirectUrl: imagePassCheckoutReturnUrl(providerIntent.id),
			cancelUrl: imagePassCheckoutCancelUrl(providerIntent.id),
			customerId: customer?.providerCustomerId,
		};

		if (providerIntent.status === "PROVIDER_CREATING") {
			try {
				const recovery = await observeCheckoutOperation(
					{ ...diagnosticIdentity, operation: "recovery" },
					() =>
						recoverProviderCreatingCheckout(
							{
								provider: providerDefinition,
								owner,
								intent: providerIntent,
								checkoutOptions,
								now: new Date(),
							},
							db,
						),
					(result) => (result.kind === "RECOVERED" ? "succeeded" : "unconfirmed"),
				);
				if (recovery.kind === "RECOVERED") {
					return { checkoutLink: recovery.checkout.checkoutUrl, intentId: providerIntent.id };
				}
				if (recovery.kind === "REVIEW") throw new ORPCError("CONFLICT");
			} catch (error) {
				if (error instanceof ORPCError) throw error;
				logger.error(
					{ provider, intentId: providerIntent.id, errorClass: imagePassCheckoutErrorClass(error) },
					"Credit-pack checkout recovery failed",
				);
				throw new ORPCError("INTERNAL_SERVER_ERROR");
			}
		}

		try {
			await markPaymentCheckoutIntentProviderCreating(
				{ intentId: providerIntent.id, provider },
				db,
			);
		} catch (error) {
			if (isImagePassCheckoutConflict(error)) throw new ORPCError("CONFLICT");
			throw new ORPCError("INTERNAL_SERVER_ERROR");
		}

		try {
			const checkout = await observeCheckoutOperation(
				{ ...diagnosticIdentity, operation: "create" },
				() => providerDefinition.createCheckout(checkoutOptions),
			);
			await observeCheckoutOperation({ ...diagnosticIdentity, operation: "bind" }, () =>
				bindPaymentCheckoutIntentSession(
					{
						intentId: providerIntent.id,
						provider,
						providerSessionId: checkout.providerSessionId,
						...(provider === "paypal" ? { providerOrderId: checkout.providerSessionId } : {}),
						providerCheckoutUrl: checkout.checkoutUrl,
						expiresAt: checkout.expiresAt,
					},
					db,
				),
			);
			return { checkoutLink: checkout.checkoutUrl, intentId: providerIntent.id };
		} catch (error) {
			logger.error(
				{ provider, intentId: providerIntent.id, errorClass: imagePassCheckoutErrorClass(error) },
				"Credit-pack checkout creation failed",
			);
			throw new ORPCError("INTERNAL_SERVER_ERROR");
		}
	});

async function resolveImagePassCheckoutOwner(
	userId: string,
	_activeOrganizationId?: string | null,
) {
	return { ownerType: "USER" as const, ownerId: userId };
}

function isTrustedImagePassIntent(
	intent: Awaited<ReturnType<typeof getPaymentCheckoutIntentForOwner>>,
	provider: "paypal",
	packKey: string,
	submittedByUserId: string,
): intent is NonNullable<typeof intent> {
	return Boolean(
		intent &&
		intent.provider === provider &&
		intent.submittedByUserId === submittedByUserId &&
		intent.productKind === "IMAGE_PASS" &&
		intent.planKey === packKey &&
		intent.interval === "one-time" &&
		isImagePassOfferSnapshot(intent.imagePassOfferSnapshot) &&
		intent.billingPlanId === intent.billingPlan.id &&
		isImagePassBillingPlan(intent.billingPlan),
	);
}

function imagePassCheckoutReturnUrl(intentId: string): string {
	const url = new URL(
		"/image-pass-checkout-return",
		getBaseUrl(process.env.NEXT_PUBLIC_SAAS_URL, 3000),
	);
	url.searchParams.set("intentId", intentId);
	url.searchParams.set("approved", "1");
	return url.toString();
}

function imagePassCheckoutCancelUrl(intentId: string): string {
	const url = new URL("/image-pass", getBaseUrl(process.env.NEXT_PUBLIC_SAAS_URL, 3000));
	url.searchParams.set("canceled", "1");
	url.searchParams.set("intentId", intentId);
	return url.toString();
}

function isImagePassCheckoutConflict(error: unknown): boolean {
	return (
		error instanceof Error &&
		[
			"PAYMENT_CHECKOUT_INTENT_CONFLICT",
			"PAYMENT_CHECKOUT_INTENT_IDEMPOTENCY_CONFLICT",
			"PAYMENT_CHECKOUT_INTENT_REPLAY_UNSAFE",
			"PAYMENT_CHECKOUT_INTENT_PROVIDER_CREATE_CONFLICT",
		].includes(error.message)
	);
}

function imagePassCheckoutErrorClass(error: unknown): string {
	const message = error instanceof Error ? error.message : "";
	if (message.startsWith("PAYMENT_CHECKOUT_INTENT_")) {
		return "PAYMENT_CHECKOUT_INTENT_ERROR";
	}
	return "PAYMENT_PROVIDER_ERROR";
}
