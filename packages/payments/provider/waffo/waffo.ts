import type {
	CheckoutRecoveryResult,
	CreateCheckoutLinkOptions,
	CreatedCheckout,
	RecoverCheckoutOptions,
} from "../../types";
import type { VerifiedPaymentEvent } from "../webhook";
import { getWaffoEventId } from "./event-id";

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
				tokenExpiresAt?: string;
			}>;
		};
	};
	orders: {
		cancelSubscription(input: { orderId: string }): Promise<unknown>;
	};
	graphql?: {
		query<T>(input: {
			query: string;
			variables?: Record<string, unknown>;
		}): Promise<{ data?: T | null; errors?: Array<unknown>; warnings?: Array<unknown> }>;
	};
	webhooks: {
		verify(
			rawBody: string,
			signature: string | undefined | null,
			options: { environment: WaffoEnvironment },
		): unknown;
	};
}

// Authenticated checkout sessions default to 45 minutes. Waffo does not expose
// checkout sessions through its read API, so an empty order query is accepted
// as NOT_FOUND only after a much longer safety delay. Before then it remains
// unknown and must never trigger a second checkout create.
const WAFFO_LOST_SESSION_RETRY_DELAY_MS = 24 * 60 * 60 * 1_000;

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
	const result = await client.checkout.authenticated.create({
		productId: options.priceId,
		currency: options.currency,
		buyerIdentity: `${options.ownerType}:${options.ownerId}`,
		...(options.email ? { buyerEmail: options.email } : {}),
		...(options.redirectUrl ? { successUrl: options.redirectUrl } : {}),
		orderMerchantExternalId: options.checkoutIntentId,
		metadata: {
			billingPlanId: options.billingPlanId,
			...(options.type === "one-time"
				? { checkoutKind: "CREDIT_PACK", packKey: options.planKey }
				: { planKey: options.planKey }),
			ownerType: options.ownerType,
			ownerId: options.ownerId,
		},
	});
	const sessionExpiresAt = new Date(result.expiresAt);
	const tokenExpiresAt = result.tokenExpiresAt ? new Date(result.tokenExpiresAt) : null;
	if (
		!result.sessionId ||
		!result.checkoutUrl ||
		Number.isNaN(sessionExpiresAt.getTime()) ||
		(tokenExpiresAt !== null && Number.isNaN(tokenExpiresAt.getTime()))
	) {
		throw new Error("WAFFO_CHECKOUT_RESPONSE_INVALID");
	}
	const expiresAt =
		tokenExpiresAt && tokenExpiresAt < sessionExpiresAt ? tokenExpiresAt : sessionExpiresAt;
	return {
		checkoutUrl: result.checkoutUrl,
		providerSessionId: result.sessionId,
		expiresAt,
	};
}

export async function recoverWaffoCheckout(
	client: WaffoSdkBoundary,
	storeId: string,
	options: RecoverCheckoutOptions,
): Promise<CheckoutRecoveryResult> {
	if (!client.graphql || !storeId.trim()) return { status: "UNKNOWN" };
	const collection = options.type === "one-time" ? "onetimeOrders" : "subscriptionOrders";
	const query = `query RecoverCheckout($storeId: String!, $externalId: String!) {
		${collection}(
			storeId: $storeId
			limit: 2
			filter: { orderMerchantExternalId: { eq: $externalId } }
		) {
			id
			status
			orderMerchantExternalId
		}
	}`;

	try {
		const result = await client.graphql.query<Record<string, unknown>>({
			query,
			variables: { storeId, externalId: options.checkoutIntentId },
		});
		if (result.errors?.length || !result.data) return { status: "UNKNOWN" };
		const rawOrders = result.data[collection];
		if (!Array.isArray(rawOrders)) return { status: "UNKNOWN" };
		const orders = rawOrders.map(recordValue);
		if (
			orders.some(
				(order) =>
					!order ||
					!stringValue(order.id) ||
					!stringValue(order.status) ||
					stringValue(order.orderMerchantExternalId) !== options.checkoutIntentId,
			)
		) {
			return { status: "UNKNOWN" };
		}
		if (orders.length > 1) return { status: "UNKNOWN" };
		const order = orders[0];
		if (order) {
			return { status: "FOUND_UNRESUMABLE", providerOrderId: stringValue(order.id)! };
		}

		const ageMs = options.now.getTime() - options.providerCreatingAt.getTime();
		return Number.isFinite(ageMs) && ageMs >= WAFFO_LOST_SESSION_RETRY_DELAY_MS
			? { status: "NOT_FOUND" }
			: { status: "UNKNOWN" };
	} catch {
		return { status: "UNKNOWN" };
	}
}

export function createWaffoWebhookVerifier(
	client: WaffoSdkBoundary,
	environment: WaffoEnvironment,
	storeId: string,
) {
	return (rawBody: string, headers: Headers) => {
		const signature = headers.get("x-waffo-signature");
		if (!signature) throw new Error("WAFFO_WEBHOOK_SIGNATURE_MISSING");
		const verified = recordValue(client.webhooks.verify(rawBody, signature, { environment }));
		if (!verified || !stringValue(verified.id)) throw new Error("WAFFO_WEBHOOK_EVENT_INVALID");
		if (verified.mode !== environment) {
			throw new Error("WAFFO_WEBHOOK_MODE_MISMATCH");
		}
		if (verified.storeId !== storeId) {
			throw new Error("WAFFO_WEBHOOK_STORE_MISMATCH");
		}
		if (!stringValue(verified.eventId)) throw new Error("WAFFO_WEBHOOK_EVENT_INVALID");
		const data = recordValue(verified.data);
		return {
			providerEventId: getWaffoEventId(verified),
			normalizedTransactionId: stringValue(verified.eventId) ?? undefined,
			providerSubscriptionId: stringValue(data?.orderId) ?? undefined,
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
