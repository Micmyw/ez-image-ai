import {
	canReviewLegacyCheckout,
	readCheckoutRecovery,
	type RecoverableCheckout,
	type CheckoutReviewObservation,
} from "@repo/database";

import type { PaymentProvider } from "../../types";
import { paymentReconciliationScope } from "../event-reconciliation";
import { listPayPalPaymentEvents } from "./event-source";
import {
	cancelPayPalSubscription,
	capturePayPalCheckoutOrder,
	createPayPalCheckoutLink,
	createPayPalWebhookVerifier,
	getPayPalAccessToken,
	recoverPayPalCheckout,
	inspectPayPalSubscriptionCheckout,
	inspectPayPalSubscriptionCancellation,
	recoverPayPalSubscriptionCheckout,
	activatePayPalSubscriptionCheckout,
	type PayPalHttpBoundary,
} from "./paypal";

interface PayPalRuntimeConfiguration {
	baseUrl: string;
	clientId: string;
	clientSecret: string;
	webhookId: string;
}

export function createPayPalHttpBoundary(
	fetchImplementation: typeof fetch = fetch,
): PayPalHttpBoundary {
	return {
		async request(input) {
			const response = await fetchImplementation(input.url, {
				method: input.method,
				signal: AbortSignal.timeout(15_000),
				headers: input.headers,
				...(input.body === undefined
					? {}
					: {
							body: typeof input.body === "string" ? input.body : JSON.stringify(input.body),
						}),
			});
			const text = await response.text();
			let body: unknown = null;
			if (text) {
				try {
					body = JSON.parse(text) as unknown;
				} catch {
					body = null;
				}
			}
			return { status: response.status, body };
		},
	};
}

export function createPayPalProvider(
	environment: Record<string, string | undefined> = process.env,
	http = createPayPalHttpBoundary(),
): PaymentProvider {
	const configuration = getPayPalRuntimeConfiguration(environment);
	return {
		name: "paypal",
		capabilities: {
			checkout: true,
			portal: false,
			cancellation: true,
			seatUpdates: false,
			webhooks: true,
		},
		async createCheckout(options) {
			const accessToken = await authorizePayPal(http, configuration);
			return createPayPalCheckoutLink(
				http,
				{ accessToken, baseUrl: configuration.baseUrl },
				options,
			);
		},
		async recoverCheckout(options) {
			const accessToken = await authorizePayPal(http, configuration);
			return recoverPayPalCheckout(http, { accessToken, baseUrl: configuration.baseUrl }, options);
		},
		async listPaymentEvents(window) {
			const accessToken = await authorizePayPal(http, configuration);
			return listPayPalPaymentEvents(http, { accessToken, baseUrl: configuration.baseUrl }, window);
		},
		async inspectCheckout(input) {
			const accessToken = await authorizePayPal(http, configuration);
			return inspectPayPalSubscriptionCheckout(
				http,
				{ accessToken, baseUrl: configuration.baseUrl },
				input,
			);
		},
		async recoverSubscriptionCheckout(input) {
			const accessToken = await authorizePayPal(http, configuration);
			return recoverPayPalSubscriptionCheckout(
				http,
				{ accessToken, baseUrl: configuration.baseUrl },
				input,
			);
		},
		async activateSubscriptionCheckout(input) {
			const accessToken = await authorizePayPal(http, configuration);
			return activatePayPalSubscriptionCheckout(
				http,
				{ accessToken, baseUrl: configuration.baseUrl },
				input,
			);
		},
		async captureCheckout(options) {
			const accessToken = await authorizePayPal(http, configuration);
			return capturePayPalCheckoutOrder(
				http,
				{ accessToken, baseUrl: configuration.baseUrl },
				options,
			);
		},
		async cancelSubscription(id) {
			const accessToken = await authorizePayPal(http, configuration);
			await cancelPayPalSubscription(http, { accessToken, baseUrl: configuration.baseUrl }, id);
		},
		async inspectSubscriptionCancellation(input) {
			const accessToken = await authorizePayPal(http, configuration);
			return inspectPayPalSubscriptionCancellation(
				http,
				{ accessToken, baseUrl: configuration.baseUrl },
				input,
			);
		},
	};
}

export function createConfiguredPayPalWebhookVerifier(
	environment: Record<string, string | undefined> = process.env,
	http = createPayPalHttpBoundary(),
) {
	return async (rawBody: string, headers: Headers) => {
		const configuration = getPayPalRuntimeConfiguration(environment);
		const accessToken = await authorizePayPal(http, configuration);
		return createPayPalWebhookVerifier(http, {
			accessToken,
			baseUrl: configuration.baseUrl,
			webhookId: configuration.webhookId,
		})(rawBody, headers);
	};
}

/** Fresh read-only evidence for an operator decision; a 404 alone never closes a checkout. */
export async function inspectPayPalCheckoutReview(
	intent: RecoverableCheckout,
	environment: Record<string, string | undefined> = process.env,
	http = createPayPalHttpBoundary(),
): Promise<CheckoutReviewObservation> {
	if (!canReviewLegacyCheckout(intent)) throw new Error("CHECKOUT_REVIEW_NOT_ELIGIBLE");
	const paypalEnvironment = environment.PAYPAL_ENVIRONMENT;
	const state = readCheckoutRecovery(intent.checkoutRecovery);
	const metadata = intent.billingPlan.metadata as Record<string, unknown> | null;
	let checkoutUrl: URL;
	let scope: string;
	try {
		checkoutUrl = new URL(intent.providerCheckoutUrl ?? "");
		scope = paymentReconciliationScope("paypal", environment);
	} catch {
		throw new Error("CHECKOUT_REVIEW_PROVENANCE_UNCONFIRMED");
	}
	if (
		(paypalEnvironment !== "sandbox" && paypalEnvironment !== "live") ||
		metadata?.providerEnvironment !== paypalEnvironment ||
		(state.environment && state.environment !== paypalEnvironment) ||
		(state.scope && state.scope !== scope) ||
		checkoutUrl.protocol !== "https:" ||
		checkoutUrl.port ||
		checkoutUrl.username ||
		checkoutUrl.password ||
		checkoutUrl.hostname !==
			(paypalEnvironment === "live" ? "www.paypal.com" : "www.sandbox.paypal.com")
	)
		throw new Error("CHECKOUT_REVIEW_PROVENANCE_UNCONFIRMED");
	const configuration = getPayPalRuntimeConfiguration(environment);
	const accessToken = await authorizePayPal(http, configuration);
	const headers = { Authorization: `Bearer ${accessToken}` };
	const subscription = await http.request({
		method: "GET",
		headers,
		url: `${configuration.baseUrl}/v1/billing/subscriptions/${encodeURIComponent(intent.providerSessionId!)}`,
	});
	const body = subscription.body as { name?: string; details?: Array<{ issue?: string }> } | null;
	if (
		subscription.status !== 404 ||
		body?.name !== "RESOURCE_NOT_FOUND" ||
		!Array.isArray(body.details) ||
		!body.details.some((detail) => detail?.issue === "INVALID_RESOURCE_ID")
	)
		throw new Error("CHECKOUT_REVIEW_PROVIDER_UNCONFIRMED");
	// Historical attempts predate merchant-scope snapshots. Authenticate access to their
	// original plan as well as checking persisted environment provenance.
	const plan = await http.request({
		method: "GET",
		headers,
		url: `${configuration.baseUrl}/v1/billing/plans/${encodeURIComponent(intent.billingPlan.providerPriceId)}`,
	});
	const originalPlan = plan.body as { id?: string; status?: string } | null;
	if (
		plan.status !== 200 ||
		originalPlan?.id !== intent.billingPlan.providerPriceId ||
		!["ACTIVE", "INACTIVE", "CREATED"].includes(String(originalPlan?.status))
	)
		throw new Error("CHECKOUT_REVIEW_PROVENANCE_UNCONFIRMED");
	return {
		status: "UNKNOWN",
		reason: "RESOURCE_NOT_FOUND",
		checkedAt: new Date().toISOString(),
		environment: paypalEnvironment,
		scope,
		priceId: intent.billingPlan.providerPriceId,
		providerSessionId: intent.providerSessionId!,
	};
}

function authorizePayPal(http: PayPalHttpBoundary, configuration: PayPalRuntimeConfiguration) {
	return getPayPalAccessToken(http, configuration);
}

function getPayPalRuntimeConfiguration(
	environment: Record<string, string | undefined>,
): PayPalRuntimeConfiguration {
	const paypalEnvironment = environment.PAYPAL_ENVIRONMENT;
	if (paypalEnvironment !== "sandbox" && paypalEnvironment !== "live") {
		throw new Error("PAYPAL_CONFIGURATION_INCOMPLETE");
	}
	return {
		baseUrl:
			paypalEnvironment === "live"
				? "https://api-m.paypal.com"
				: "https://api-m.sandbox.paypal.com",
		clientId: requiredValue(environment.PAYPAL_CLIENT_ID),
		clientSecret: requiredValue(environment.PAYPAL_CLIENT_SECRET),
		webhookId: requiredValue(environment.PAYPAL_WEBHOOK_ID),
	};
}

function requiredValue(value: string | undefined): string {
	const result = value?.trim();
	if (!result) throw new Error("PAYPAL_CONFIGURATION_INCOMPLETE");
	return result;
}

export * from "./paypal";
