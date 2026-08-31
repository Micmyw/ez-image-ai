import type { CreateCheckoutLinkOptions, CreatedCheckout } from "../../types";
import type { VerifiedPaymentEvent } from "../webhook";

type WaffoEnvironment = "test" | "prod";

export interface WaffoSdkBoundary {
	checkout: {
		authenticated: {
			create(input: {
				productId: string;
				currency: string;
				buyerIdentity: string;
				buyerEmail?: string;
				successUrl?: string;
				orderMerchantExternalId: string;
				metadata: Record<string, string>;
			}): Promise<{
				sessionId: string;
				checkoutUrl: string;
				expiresAt: string;
			}>;
		};
	};
	orders: {
		cancelSubscription(input: { orderId: string }): Promise<unknown>;
	};
	webhooks: {
		verify(
			rawBody: string,
			signature: string | undefined | null,
			options: { environment: WaffoEnvironment },
		): unknown;
	};
}

export async function cancelWaffoSubscription(
	client: WaffoSdkBoundary,
	providerSubscriptionId: string,
): Promise<void> {
	if (!providerSubscriptionId.trim()) throw new Error("WAFFO_SUBSCRIPTION_ID_MISSING");
	await client.orders.cancelSubscription({ orderId: providerSubscriptionId });
}

export async function createWaffoCheckoutLink(
	client: WaffoSdkBoundary,
	options: CreateCheckoutLinkOptions,
): Promise<CreatedCheckout> {
	if (options.type !== "subscription") throw new Error("WAFFO_CHECKOUT_TYPE_UNSUPPORTED");
	const result = await client.checkout.authenticated.create({
		productId: options.priceId,
		currency: options.currency,
		buyerIdentity: `${options.ownerType}:${options.ownerId}`,
		...(options.email ? { buyerEmail: options.email } : {}),
		...(options.redirectUrl ? { successUrl: options.redirectUrl } : {}),
		orderMerchantExternalId: options.checkoutIntentId,
		metadata: {
			billingPlanId: options.billingPlanId,
			planKey: options.planKey,
			ownerType: options.ownerType,
			ownerId: options.ownerId,
		},
	});
	const expiresAt = new Date(result.expiresAt);
	if (!result.sessionId || !result.checkoutUrl || Number.isNaN(expiresAt.getTime())) {
		throw new Error("WAFFO_CHECKOUT_RESPONSE_INVALID");
	}
	return {
		checkoutUrl: result.checkoutUrl,
		providerSessionId: result.sessionId,
		expiresAt,
	};
}

export function createWaffoWebhookVerifier(
	client: WaffoSdkBoundary,
	environment: WaffoEnvironment,
) {
	return (rawBody: string, headers: Headers) => {
		const signature = headers.get("x-waffo-signature");
		if (!signature) throw new Error("WAFFO_WEBHOOK_SIGNATURE_MISSING");
		const verified = recordValue(client.webhooks.verify(rawBody, signature, { environment }));
		const providerEventId = stringValue(verified?.id);
		if (!verified || !providerEventId) throw new Error("WAFFO_WEBHOOK_EVENT_INVALID");
		return {
			providerEventId,
			normalizedTransactionId: stringValue(verified.eventId) ?? undefined,
			envelope: verified,
		} satisfies VerifiedPaymentEvent;
	};
}

function recordValue(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}
