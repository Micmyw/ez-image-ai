import {
	objectRecord,
	paymentCurrency,
	paymentDate,
	paymentDecimalMicros,
	type AdminRefundPayment,
} from "@repo/database";

import type {
	AdminRefundAdapter,
	AdminRefundObservation,
	AdminRefundRequestRecord,
} from "./admin-refunds-types";
import { normalizeProviderPaymentEvent } from "./lifecycle-normalization";
import { createPayPalHttpBoundary, getPayPalAccessToken, type PayPalHttpBoundary } from "./paypal";
import { listPayPalPaymentEvents } from "./paypal/event-source";

export function createPayPalAdminRefundAdapter(
	environment: Record<string, string | undefined> = process.env,
	http: PayPalHttpBoundary = createPayPalHttpBoundary(),
): AdminRefundAdapter {
	const mode = environment.PAYPAL_ENVIRONMENT;
	if (
		(mode !== "live" && mode !== "sandbox") ||
		!environment.PAYPAL_CLIENT_ID ||
		!environment.PAYPAL_CLIENT_SECRET
	)
		throw new Error("PAYPAL_CONFIGURATION_INCOMPLETE");
	const baseUrl = mode === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
	const configuration = {
		baseUrl,
		clientId: environment.PAYPAL_CLIENT_ID,
		clientSecret: environment.PAYPAL_CLIENT_SECRET,
	};
	const authorize = () => getPayPalAccessToken(http, configuration);
	async function get(path: string, accessToken: string) {
		const response = await http.request({
			method: "GET",
			url: `${baseUrl}${path}`,
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		if (response.status !== 200) throw new Error("PAYPAL_REFUND_RETRIEVAL_UNAVAILABLE");
		return objectRecord(response.body);
	}
	async function retrieve(
		payment: AdminRefundPayment,
		request: AdminRefundRequestRecord,
		refundId: string,
		accessToken: string,
	): Promise<AdminRefundObservation> {
		const sale = payment.productKind === "PLAN";
		const body = await get(
			sale
				? `/v1/payments/refund/${encodeURIComponent(refundId)}`
				: `/v2/payments/refunds/${encodeURIComponent(refundId)}`,
			accessToken,
		);
		const amount = objectRecord(body.amount);
		const binding = sale ? body.sale_id : captureBinding(body.links, baseUrl);
		if (
			body.id !== refundId ||
			binding !== payment.providerPaymentId ||
			paymentCurrency(sale ? amount.currency : amount.currency_code) !== request.currency ||
			paymentDecimalMicros(sale ? amount.total : amount.value) !== request.amountMicros
		)
			throw new Error("PAYPAL_REFUND_BINDING_MISMATCH");
		const state = String(sale ? body.state : body.status).toUpperCase();
		if (["COMPLETED", "SUCCEEDED"].includes(state))
			return {
				status: "SUCCEEDED",
				providerRefundId: refundId,
				amountMicros: request.amountMicros,
				currency: request.currency,
				occurredAt: paymentDate(body.create_time),
			};
		if (["FAILED", "CANCELLED", "CANCELED"].includes(state))
			return { status: "FAILED", providerRefundId: refundId, error: "PAYPAL_REFUND_FAILED" };
		return { status: "PROCESSING", providerRefundId: refundId };
	}
	return {
		name: "paypal",
		async verifyPayment(payment) {
			if (payment.provider !== "paypal" || payment.providerEnvironment !== mode)
				throw new Error("ADMIN_REFUND_ENVIRONMENT_MISMATCH");
			const accessToken = await authorize();
			const sale = payment.productKind === "PLAN";
			const body = await get(
				sale
					? `/v1/payments/sale/${encodeURIComponent(payment.providerPaymentId)}`
					: `/v2/payments/captures/${encodeURIComponent(payment.providerPaymentId)}`,
				accessToken,
			);
			const amount = objectRecord(body.amount);
			if (
				body.id !== payment.providerPaymentId ||
				paymentDecimalMicros(sale ? amount.total : amount.value) !== payment.amountMicros ||
				paymentCurrency(sale ? amount.currency : amount.currency_code) !== payment.currency ||
				(sale
					? body.billing_agreement_id !== payment.providerSubscriptionId
					: objectRecord(objectRecord(body.supplementary_data).related_ids).order_id !==
						payment.providerOrderId)
			)
				throw new Error("PAYPAL_REFUND_PAYMENT_MISMATCH");
			const state = String(sale ? body.state : body.status).toUpperCase();
			if (!["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"].includes(state))
				throw new Error("PAYPAL_REFUND_PAYMENT_NOT_SETTLED");
		},
		async submit(payment, request) {
			if (request.providerEnvironment !== mode)
				throw new Error("ADMIN_REFUND_ENVIRONMENT_MISMATCH");
			const accessToken = await authorize();
			const sale = payment.productKind === "PLAN";
			const amount = refundDecimalAmount(request.amountMicros);
			const response = await http.request({
				method: "POST",
				url: `${baseUrl}${
					sale
						? `/v1/payments/sale/${encodeURIComponent(payment.providerPaymentId)}/refund`
						: `/v2/payments/captures/${encodeURIComponent(payment.providerPaymentId)}/refund`
				}`,
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"Content-Type": "application/json",
					"PayPal-Request-Id": request.providerRequestId,
				},
				body: sale
					? { amount: { total: amount, currency: request.currency } }
					: {
							amount: { value: amount, currency_code: request.currency },
							invoice_id: request.providerRequestId,
							...(request.reason ? { note_to_payer: request.reason.slice(0, 255) } : {}),
						},
			});
			const body = objectRecord(response.body);
			if (response.status < 200 || response.status >= 300 || typeof body.id !== "string") {
				// HTTP failure can follow provider acceptance. Keep the same command
				// and inspect it; never release it as a new refundable payment.
				return { status: "UNKNOWN", error: "PAYPAL_REFUND_SUBMISSION_UNCONFIRMED" };
			}
			try {
				return await retrieve(payment, request, body.id, accessToken);
			} catch {
				return {
					status: "PROCESSING",
					providerRefundId: body.id,
					error: "PAYPAL_REFUND_CONFIRMATION_PENDING",
				};
			}
		},
		async inspect(payment, request) {
			if (request.providerEnvironment !== mode)
				throw new Error("ADMIN_REFUND_ENVIRONMENT_MISMATCH");
			const accessToken = await authorize();
			if (request.providerRefundId)
				return retrieve(payment, request, request.providerRefundId, accessToken);
			// A provider response may be lost before its refund ID reaches Postgres.
			// Authenticated original-event retrieval recovers the ID without issuing
			// another refund or depending on an idempotency retention window.
			let cursor: string | null = null;
			const matches = new Set<string>();
			for (let page = 0; page < 10; page += 1) {
				const result = await listPayPalPaymentEvents(
					http,
					{ accessToken, baseUrl },
					{
						since: new Date(request.createdAt.getTime() - 60_000),
						until: new Date(),
						cursor,
						limit: 100,
					},
				);
				for (const event of result.events) {
					try {
						const normalized = normalizeProviderPaymentEvent("paypal", event.envelope);
						if (
							(normalized.kind === "PAYMENT_REFUNDED" ||
								normalized.kind === "CREDIT_PACK_REFUNDED") &&
							normalized.fact.adjustmentKind !== "REVERSAL" &&
							normalized.fact.providerPaymentId === payment.providerPaymentId &&
							normalized.fact.amountMicros === request.amountMicros &&
							normalized.fact.currency === request.currency &&
							normalized.fact.occurredAt.getTime() >= request.createdAt.getTime() - 60_000
						)
							matches.add(normalized.fact.providerRefundId);
					} catch {
						/* Unrelated or malformed provider events are not receipts. */
					}
				}
				cursor = result.nextCursor;
				if (!cursor) break;
			}
			if (cursor || matches.size !== 1)
				return { status: "UNKNOWN", error: "PAYPAL_REFUND_CONFIRMATION_PENDING" };
			return retrieve(payment, request, [...matches][0]!, accessToken);
		},
	};
}

function captureBinding(value: unknown, baseUrl: string): string | null {
	if (!Array.isArray(value)) return null;
	for (const item of value) {
		const link = objectRecord(item);
		if (link.rel !== "up" || typeof link.href !== "string") continue;
		const url = new URL(link.href);
		if (url.origin !== new URL(baseUrl).origin) return null;
		return /^\/v2\/payments\/captures\/([^/]+)$/.exec(url.pathname)?.[1] ?? null;
	}
	return null;
}

export function refundDecimalAmount(amount: bigint): string {
	if (amount <= 0n || amount % 10_000n !== 0n)
		throw new Error("ADMIN_REFUND_CURRENCY_PRECISION_UNSUPPORTED");
	return `${amount / 1_000_000n}.${((amount % 1_000_000n) / 10_000n).toString().padStart(2, "0")}`;
}
