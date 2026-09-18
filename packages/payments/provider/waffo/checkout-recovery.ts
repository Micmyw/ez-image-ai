import type {
	SubscriptionCheckoutInspection,
	SubscriptionCheckoutRecoveryInput,
} from "../../types";
import type { WaffoSdkBoundary } from "./waffo";

export async function recoverWaffoSubscriptionCheckout(
	client: WaffoSdkBoundary,
	storeId: string,
	input: SubscriptionCheckoutRecoveryInput,
): Promise<SubscriptionCheckoutInspection> {
	if (!client.graphql) return { status: "UNKNOWN" };
	const inspect = () =>
		client.graphql!.query<{
			subscriptionOrders: Array<{
				id: string;
				status: string;
				orderMerchantExternalId: string;
				activateAt: string | null;
				currentPeriodStart: string | null;
				payments: Array<{ status: string }>;
			}>;
		}>({
			query: `query RecoverSubscriptionCheckout($storeId: String!, $externalId: String!) { subscriptionOrders(storeId: $storeId, limit: 2, filter: { orderMerchantExternalId: { eq: $externalId } }) { id status orderMerchantExternalId activateAt currentPeriodStart payments { status } } }`,
			variables: { storeId, externalId: input.checkoutIntentId },
		});
	const valid = (result: Awaited<ReturnType<typeof inspect>>) =>
		!result.errors?.length &&
		!result.warnings?.length &&
		Array.isArray(result.data?.subscriptionOrders) &&
		result.data.subscriptionOrders.length <= 1 &&
		result.data.subscriptionOrders.every(
			(order) => Boolean(order.id) && order.orderMerchantExternalId === input.checkoutIntentId,
		);
	let result = await inspect();
	if (!valid(result)) return { status: "UNKNOWN", reason: "PROVIDER_BINDING_UNCONFIRMED" };
	let order = result.data!.subscriptionOrders[0];
	if (input.providerOrderId && order?.id !== input.providerOrderId)
		return { status: "UNKNOWN", reason: "PROVIDER_BINDING_UNCONFIRMED" };
	if (
		input.cancelRequested &&
		order?.status === "pending" &&
		Array.isArray(order.payments) &&
		order.payments.every((payment) => payment.status === "failed")
	) {
		try {
			await client.orders.cancelSubscription({ orderId: order.id });
		} catch {
			/* Read back even after a timeout. */
		}
		result = await inspect();
		if (!valid(result) || result.data!.subscriptionOrders[0]?.id !== order.id)
			return { status: "UNKNOWN", reason: "CANCELLATION_UNCONFIRMED" };
		order = result.data!.subscriptionOrders[0];
	}
	if (
		order &&
		(order.activateAt ||
			order.currentPeriodStart ||
			["active", "trialing", "past_due", "canceling"].includes(order.status) ||
			order.payments?.some((payment) => payment.status === "succeeded"))
	)
		return { status: "PAID", providerOrderId: order.id };
	if (
		order &&
		(!Array.isArray(order.payments) ||
			order.payments.some((payment) => payment.status !== "failed"))
	)
		return { status: "UNKNOWN", providerOrderId: order.id, reason: "PAYMENT_IN_FLIGHT" };
	if (order && !["pending", "canceled", "closed"].includes(order.status))
		return { status: "UNKNOWN", reason: "PROVIDER_STATUS_UNCONFIRMED" };
	if (order?.status === "pending" && !input.cancelRequested)
		return { status: "PENDING", providerOrderId: order.id };
	// Revoking a pending order does not revoke the checkout session. Fence both.
	if (!input.sessionExpiryVerified || !input.expiresAt)
		return {
			status: "UNKNOWN",
			reason: "SESSION_DEADLINE_UNCONFIRMED",
			providerOrderId: order?.id,
		};
	if (input.now < input.expiresAt)
		return {
			status: input.cancelRequested ? "WAITING" : "PENDING",
			waitUntil: input.expiresAt,
			providerOrderId: order?.id,
		};
	if (order?.status === "pending")
		return { status: "UNKNOWN", reason: "CANCELLATION_UNCONFIRMED", providerOrderId: order.id };
	if (order && (order.activateAt !== null || order.currentPeriodStart !== null))
		return { status: "UNKNOWN", reason: "PAYMENT_HISTORY_UNCONFIRMED" };
	return { status: "CLOSED", providerOrderId: order?.id };
}

export async function resumeWaffoSubscriptionCheckout(
	client: WaffoSdkBoundary,
	input: {
		checkoutUrl: string;
		priceId: string;
		ownerType: "USER" | "ORGANIZATION";
		ownerId: string;
	},
): Promise<string> {
	if (!client.auth) throw new Error("WAFFO_SESSION_AUTH_UNAVAILABLE");
	const { token, expiresAt } = await client.auth.issueSessionToken({
		productId: input.priceId,
		buyerIdentity: `${input.ownerType}:${input.ownerId}`,
	});
	if (!token || !(new Date(expiresAt) > new Date()))
		throw new Error("WAFFO_SESSION_AUTH_UNAVAILABLE");
	const url = new URL(input.checkoutUrl);
	url.hash = new URLSearchParams({ token }).toString();
	return url.toString();
}
