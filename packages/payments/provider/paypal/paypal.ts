import type {
	CapturedCheckoutEvent,
	CaptureCheckoutOptions,
	CreateCheckoutLinkOptions,
	CreatedCheckout,
	RecoverCheckoutOptions,
	CheckoutRecoveryResult,
} from "../../types";
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

// PayPal documents a default idempotency-key retention of at least six hours.
// Keep an hour of margin for clock skew and request propagation; older creates
// cannot be safely replayed without risking a second provider resource.
const PAYPAL_SAFE_CREATE_REPLAY_MS = 5 * 60 * 60 * 1_000;

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
	if (options.type === "one-time") {
		return createPayPalOrderCheckoutLink(http, configuration, options);
	}
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

export async function recoverPayPalCheckout(
	http: PayPalHttpBoundary,
	configuration: PayPalAuthorizedConfiguration,
	options: RecoverCheckoutOptions,
): Promise<CheckoutRecoveryResult> {
	const ageMs = options.now.getTime() - options.providerCreatingAt.getTime();
	if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > PAYPAL_SAFE_CREATE_REPLAY_MS) {
		return { status: "UNKNOWN" };
	}

	try {
		const checkout = await createPayPalCheckoutLink(http, configuration, options);
		return {
			status: "FOUND",
			checkout,
			...(options.type === "one-time" ? { providerOrderId: checkout.providerSessionId } : {}),
		};
	} catch {
		return { status: "UNKNOWN" };
	}
}

async function createPayPalOrderCheckoutLink(
	http: PayPalHttpBoundary,
	configuration: PayPalAuthorizedConfiguration,
	options: CreateCheckoutLinkOptions,
): Promise<CreatedCheckout> {
	const amount = paypalAmount(options.amountMicros, options.currency);
	const description = options.description?.trim();
	if (!description) throw new Error("PAYPAL_CHECKOUT_DESCRIPTION_MISSING");
	const response = await http.request({
		method: "POST",
		url: `${configuration.baseUrl}/v2/checkout/orders`,
		headers: {
			Authorization: `Bearer ${configuration.accessToken}`,
			"Content-Type": "application/json",
			"PayPal-Request-Id": options.idempotencyKey,
			Prefer: "return=representation",
		},
		body: {
			intent: "CAPTURE",
			purchase_units: [
				{
					reference_id: options.planKey,
					custom_id: options.checkoutIntentId,
					description,
					amount: {
						currency_code: options.currency,
						value: amount,
						breakdown: {
							item_total: { currency_code: options.currency, value: amount },
						},
					},
					items: [
						{
							name: description,
							sku: options.priceId,
							quantity: "1",
							unit_amount: { currency_code: options.currency, value: amount },
						},
					],
				},
			],
			payment_source: {
				paypal: {
					experience_context: {
						user_action: "PAY_NOW",
						payment_method_preference: "IMMEDIATE_PAYMENT_REQUIRED",
						shipping_preference: "NO_SHIPPING",
						return_url: options.redirectUrl ?? "",
						cancel_url: options.redirectUrl ?? "",
					},
				},
			},
		},
	});
	const body = recordValue(response.body);
	const providerSessionId = stringValue(body?.id);
	const links = Array.isArray(body?.links) ? body.links : [];
	const approval = links
		.map(recordValue)
		.find(
			(link) =>
				["approve", "payer-action"].includes(stringValue(link?.rel) ?? "") &&
				Boolean(stringValue(link?.href)),
		);
	const checkoutUrl = stringValue(approval?.href);
	if ((response.status !== 200 && response.status !== 201) || !providerSessionId || !checkoutUrl) {
		throw new Error("PAYPAL_CHECKOUT_RESPONSE_INVALID");
	}
	let creationTime = body?.create_time;
	if (creationTime === undefined || creationTime === null) {
		// Payer-action responses can omit create_time even with return=representation.
		// Read the same order so retries retain its original expiration deadline.
		const detailsResponse = await http.request({
			method: "GET",
			url: `${configuration.baseUrl}/v2/checkout/orders/${encodeURIComponent(providerSessionId)}`,
			headers: { Authorization: `Bearer ${configuration.accessToken}` },
		});
		const details = recordValue(detailsResponse.body);
		if (detailsResponse.status !== 200 || stringValue(details?.id) !== providerSessionId) {
			throw new Error("PAYPAL_CHECKOUT_RESPONSE_INVALID");
		}
		creationTime = details?.create_time;
	}
	const createdAt = new Date(stringValue(creationTime) ?? "");
	if (Number.isNaN(createdAt.getTime())) throw new Error("PAYPAL_CHECKOUT_RESPONSE_INVALID");
	return {
		checkoutUrl,
		providerSessionId,
		expiresAt: new Date(createdAt.getTime() + 3 * 60 * 60 * 1_000),
	};
}

export async function capturePayPalCheckoutOrder(
	http: PayPalHttpBoundary,
	configuration: PayPalAuthorizedConfiguration,
	options: CaptureCheckoutOptions,
): Promise<CapturedCheckoutEvent> {
	if (!options.providerOrderId.trim()) throw new Error("PAYPAL_ORDER_ID_MISSING");
	const response = await http.request({
		method: "POST",
		url: `${configuration.baseUrl}/v2/checkout/orders/${encodeURIComponent(options.providerOrderId)}/capture`,
		headers: {
			Authorization: `Bearer ${configuration.accessToken}`,
			"Content-Type": "application/json",
			"PayPal-Request-Id": options.idempotencyKey,
			Prefer: "return=representation",
		},
		body: {},
	});
	if (response.status !== 200 && response.status !== 201) {
		throw new Error("PAYPAL_CAPTURE_RESPONSE_INVALID");
	}
	const order = recordValue(response.body);
	if (
		!order ||
		stringValue(order?.id) !== options.providerOrderId ||
		stringValue(order?.status) !== "COMPLETED"
	) {
		throw new Error("PAYPAL_CAPTURE_RESPONSE_INVALID");
	}
	const purchaseUnits = Array.isArray(order.purchase_units) ? order.purchase_units : [];
	if (purchaseUnits.length !== 1) throw new Error("PAYPAL_CAPTURE_RESPONSE_INVALID");
	const purchaseUnit = recordValue(purchaseUnits[0]);
	const payments = recordValue(purchaseUnit?.payments);
	const captures = Array.isArray(payments?.captures) ? payments.captures : [];
	if (captures.length !== 1) throw new Error("PAYPAL_CAPTURE_RESPONSE_INVALID");
	const capture = recordValue(captures[0]);
	const captureId = stringValue(capture?.id);
	const occurredAt = stringValue(capture?.create_time);
	if (
		!capture ||
		!captureId ||
		stringValue(capture.status) !== "COMPLETED" ||
		capture.final_capture !== true ||
		!recordValue(capture.amount) ||
		!occurredAt ||
		Number.isNaN(new Date(occurredAt).getTime())
	) {
		throw new Error("PAYPAL_CAPTURE_RESPONSE_INVALID");
	}
	const checkoutIntentId = stringValue(purchaseUnit?.custom_id);
	if (!checkoutIntentId) throw new Error("PAYPAL_CAPTURE_RESPONSE_INVALID");
	const payer = recordValue(order.payer);
	const providerEventId = `capture-response:${captureId}`;
	return {
		providerEventId,
		normalizedTransactionId: captureId,
		envelope: {
			id: providerEventId,
			event_type: "PAYMENT.CAPTURE.COMPLETED",
			create_time: occurredAt,
			resource: {
				...capture,
				custom_id: checkoutIntentId,
				...(stringValue(payer?.payer_id) ? { payer_id: stringValue(payer?.payer_id) } : {}),
				supplementary_data: { related_ids: { order_id: options.providerOrderId } },
			},
		},
	};
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

function paypalAmount(amountMicros: bigint | undefined, currency: string): string {
	if (currency !== "USD" || amountMicros === undefined || amountMicros <= 0n) {
		throw new Error("PAYPAL_CHECKOUT_AMOUNT_INVALID");
	}
	if (amountMicros % 10_000n !== 0n) throw new Error("PAYPAL_CHECKOUT_AMOUNT_INVALID");
	const whole = amountMicros / 1_000_000n;
	const cents = (amountMicros % 1_000_000n) / 10_000n;
	return `${whole}.${cents.toString().padStart(2, "0")}`;
}
