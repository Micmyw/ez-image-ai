import type { CreateCheckoutLinkOptions, CreatedCheckout } from "../../types";
import type { VerifiedPaymentEvent } from "../webhook";

export interface PayPalHttpBoundary {
	request(input: {
		method: "GET" | "POST";
		url: string;
		headers: Record<string, string>;
		body?: unknown;
	}): Promise<{ status: number; body: unknown }>;
}

interface PayPalAuthorizedConfiguration {
	accessToken: string;
	baseUrl: string;
}

interface PayPalCredentialConfiguration {
	clientId: string;
	clientSecret: string;
	baseUrl: string;
}

interface PayPalWebhookConfiguration extends PayPalAuthorizedConfiguration {
	webhookId: string;
}

export async function getPayPalAccessToken(
	http: PayPalHttpBoundary,
	configuration: PayPalCredentialConfiguration,
): Promise<string> {
	const response = await http.request({
		method: "POST",
		url: `${configuration.baseUrl}/v1/oauth2/token`,
		headers: {
			Authorization: `Basic ${Buffer.from(
				`${configuration.clientId}:${configuration.clientSecret}`,
			).toString("base64")}`,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: "grant_type=client_credentials",
	});
	const accessToken = stringValue(recordValue(response.body)?.access_token);
	if (response.status < 200 || response.status >= 300 || !accessToken) {
		throw new Error("PAYPAL_OAUTH_RESPONSE_INVALID");
	}
	return accessToken;
}

export async function cancelPayPalSubscription(
	http: PayPalHttpBoundary,
	configuration: PayPalAuthorizedConfiguration,
	providerSubscriptionId: string,
): Promise<void> {
	if (!providerSubscriptionId.trim()) throw new Error("PAYPAL_SUBSCRIPTION_ID_MISSING");
	const response = await http.request({
		method: "POST",
		url: `${configuration.baseUrl}/v1/billing/subscriptions/${encodeURIComponent(
			providerSubscriptionId,
		)}/cancel`,
		headers: {
			Authorization: `Bearer ${configuration.accessToken}`,
			"Content-Type": "application/json",
		},
		body: { reason: "Customer requested cancellation." },
	});
	if (response.status < 200 || response.status >= 300) {
		throw new Error("PAYPAL_CANCEL_RESPONSE_INVALID");
	}
}

export async function createPayPalCheckoutLink(
	http: PayPalHttpBoundary,
	configuration: PayPalAuthorizedConfiguration,
	options: CreateCheckoutLinkOptions,
): Promise<CreatedCheckout> {
	if (options.type !== "subscription") throw new Error("PAYPAL_CHECKOUT_TYPE_UNSUPPORTED");
	const response = await http.request({
		method: "POST",
		url: `${configuration.baseUrl}/v1/billing/subscriptions`,
		headers: {
			Authorization: `Bearer ${configuration.accessToken}`,
			"Content-Type": "application/json",
			"PayPal-Request-Id": options.idempotencyKey,
			Prefer: "return=representation",
		},
		body: {
			plan_id: options.priceId,
			custom_id: options.checkoutIntentId,
			application_context: {
				return_url: options.redirectUrl ?? "",
				cancel_url: options.redirectUrl ?? "",
				user_action: "SUBSCRIBE_NOW",
			},
		},
	});
	const body = recordValue(response.body);
	const providerSessionId = stringValue(body?.id);
	const links = Array.isArray(body?.links) ? body.links : [];
	const approval = links
		.map(recordValue)
		.find((link) => stringValue(link?.rel) === "approve" && stringValue(link?.href));
	const checkoutUrl = stringValue(approval?.href);
	if (response.status < 200 || response.status >= 300 || !providerSessionId || !checkoutUrl) {
		throw new Error("PAYPAL_CHECKOUT_RESPONSE_INVALID");
	}
	return { checkoutUrl, providerSessionId, expiresAt: null };
}

export function createPayPalWebhookVerifier(
	http: PayPalHttpBoundary,
	configuration: PayPalWebhookConfiguration,
) {
	return async (rawBody: string, headers: Headers): Promise<VerifiedPaymentEvent> => {
		const event = parseJsonObject(rawBody, "PAYPAL_WEBHOOK_BODY_INVALID");
		const authAlgo = requiredHeader(headers, "paypal-auth-algo");
		const certUrl = requiredHeader(headers, "paypal-cert-url");
		const transmissionId = requiredHeader(headers, "paypal-transmission-id");
		const transmissionSignature = requiredHeader(headers, "paypal-transmission-sig");
		const transmissionTime = requiredHeader(headers, "paypal-transmission-time");
		const response = await http.request({
			method: "POST",
			url: `${configuration.baseUrl}/v1/notifications/verify-webhook-signature`,
			headers: {
				Authorization: `Bearer ${configuration.accessToken}`,
				"Content-Type": "application/json",
			},
			body: {
				auth_algo: authAlgo,
				cert_url: certUrl,
				transmission_id: transmissionId,
				transmission_sig: transmissionSignature,
				transmission_time: transmissionTime,
				webhook_id: configuration.webhookId,
				webhook_event: event,
			},
		});
		if (
			response.status < 200 ||
			response.status >= 300 ||
			stringValue(recordValue(response.body)?.verification_status) !== "SUCCESS"
		) {
			throw new Error("PAYPAL_WEBHOOK_SIGNATURE_INVALID");
		}
		const providerEventId = stringValue(event.id);
		if (!providerEventId) throw new Error("PAYPAL_WEBHOOK_EVENT_ID_MISSING");
		return {
			providerEventId,
			normalizedTransactionId: stringValue(recordValue(event.resource)?.id) ?? undefined,
			providerSubscriptionId: paypalSubscriptionId(event),
			envelope: event,
		};
	};
}

function paypalSubscriptionId(event: Record<string, unknown>): string | undefined {
	const eventType = stringValue(event.event_type);
	const resource = recordValue(event.resource);
	if (!eventType || !resource) return undefined;
	if (eventType.startsWith("BILLING.SUBSCRIPTION.")) {
		return stringValue(resource.id) ?? undefined;
	}
	if (eventType.startsWith("PAYMENT.SALE.")) {
		return stringValue(resource.billing_agreement_id) ?? undefined;
	}
	return undefined;
}

function requiredHeader(headers: Headers, name: string): string {
	const value = headers.get(name)?.trim();
	if (!value) throw new Error("PAYPAL_WEBHOOK_SIGNATURE_HEADERS_MISSING");
	return value;
}

function parseJsonObject(value: string, code: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(value);
		const record = recordValue(parsed);
		if (record) return record;
	} catch {
		// Stable public error below.
	}
	throw new Error(code);
}

function recordValue(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}
