import { createHash, createPrivateKey, createSign } from "node:crypto";

import {
	objectRecord,
	paymentCurrency,
	paymentDate,
	paymentDecimalMicros,
	type AdminRefundPayment,
} from "@repo/database";

import { refundDecimalAmount } from "./admin-refunds-paypal";
import type {
	AdminRefundAdapter,
	AdminRefundObservation,
	AdminRefundRequestRecord,
} from "./admin-refunds-types";
import { createWaffoClient } from "./waffo";

export interface WaffoAdminRefundBoundary {
	query(input: { query: string; variables: Record<string, unknown> }): Promise<{
		data?: Record<string, unknown> | null;
		errors?: readonly unknown[];
		warnings?: readonly unknown[];
	}>;
	createTicket(input: {
		paymentId: string;
		reason: string;
		requestedAmount: { amount: string; currency: string };
		refundTicketMerchantExternalId: string;
	}): Promise<{ status: number; body: unknown }>;
}

/** The SDK's customer helper is not the merchant-authorized refund endpoint. */
export function createWaffoAdminRefundBoundary(
	environment: Record<string, string | undefined> = process.env,
	fetchImplementation: typeof fetch = fetch,
): WaffoAdminRefundBoundary {
	const client = createWaffoClient(environment, { fetch: fetchImplementation });
	const merchantId = environment.WAFFO_MERCHANT_ID?.trim();
	let pem = environment.WAFFO_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
	if (!merchantId || !pem) throw new Error("WAFFO_CONFIGURATION_INCOMPLETE");
	if (!pem.includes("-----BEGIN")) {
		const body = pem.replace(/\s/g, "");
		if (!/^[A-Za-z0-9+/]+=*$/.test(body)) throw new Error("WAFFO_CONFIGURATION_INCOMPLETE");
		pem = `-----BEGIN PRIVATE KEY-----\n${body.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----`;
	}
	const key = createPrivateKey(pem);
	return {
		query: (input) => client.graphql.query<Record<string, unknown>>(input),
		async createTicket(input) {
			const path = "/v1/actions/refund-ticket/create-ticket";
			const body = JSON.stringify(input);
			const timestamp = Math.floor(Date.now() / 1_000).toString();
			const hash = createHash("sha256").update(body).digest("base64");
			const signer = createSign("sha256");
			signer.update(`POST\n${path}\n${timestamp}\n${hash}`);
			const response = await fetchImplementation(`https://api.waffo.ai${path}`, {
				method: "POST",
				redirect: "manual",
				signal: AbortSignal.timeout(15_000),
				headers: {
					"Content-Type": "application/json",
					"X-Merchant-Id": merchantId,
					"X-Timestamp": timestamp,
					"X-Signature": signer.sign(key, "base64"),
					"X-Idempotency-Key": input.refundTicketMerchantExternalId,
				},
				body,
			});
			let result: unknown;
			try {
				result = await response.json();
			} catch {
				result = null;
			}
			return { status: response.status, body: result };
		},
	};
}

export function createWaffoAdminRefundAdapter(
	environment: Record<string, string | undefined> = process.env,
	boundary: WaffoAdminRefundBoundary = createWaffoAdminRefundBoundary(environment),
): AdminRefundAdapter {
	const mode = environment.WAFFO_ENVIRONMENT;
	const storeId = environment.WAFFO_STORE_ID;
	if ((mode !== "test" && mode !== "prod") || !storeId)
		throw new Error("WAFFO_CONFIGURATION_INCOMPLETE");
	function assertEnvironment(payment: AdminRefundPayment) {
		if (payment.provider !== "waffo" || payment.providerEnvironment !== mode)
			throw new Error("ADMIN_REFUND_ENVIRONMENT_MISMATCH");
	}
	async function inspect(
		payment: AdminRefundPayment,
		request: AdminRefundRequestRecord,
	): Promise<AdminRefundObservation> {
		assertEnvironment(payment);
		const response = await boundary.query({
			query: `query AdminRefundStatus($reference: String!) {
				refundTickets(limit: 2, filter: { refundTicketMerchantExternalId: { eq: $reference } }) {
					id status subjectId refundTicketMerchantExternalId
					versionData { requestedAmount { amount currency } }
				}
				refunds(limit: 2, filter: { refundTicketMerchantExternalId: { eq: $reference } }) {
					id status paymentId testMode refundTicketMerchantExternalId
					amount { display currency } createdAt
				}
			}`,
			variables: { reference: request.providerRequestId },
		});
		if (
			response.errors?.length ||
			response.warnings?.length ||
			!Array.isArray(response.data?.refundTickets) ||
			!Array.isArray(response.data?.refunds)
		)
			throw new Error("WAFFO_REFUND_RETRIEVAL_INVALID");
		const refunds = response.data.refunds;
		const tickets = response.data.refundTickets;
		if (refunds.length > 1 || tickets.length > 1)
			return { status: "UNKNOWN", error: "WAFFO_REFUND_REFERENCE_AMBIGUOUS" };
		if (refunds.length === 1) {
			const refund = objectRecord(refunds[0]);
			const amount = objectRecord(refund.amount);
			if (
				refund.paymentId !== payment.providerPaymentId ||
				refund.testMode !== (mode === "test") ||
				refund.refundTicketMerchantExternalId !== request.providerRequestId ||
				paymentDecimalMicros(amount.display) !== request.amountMicros ||
				paymentCurrency(amount.currency) !== request.currency ||
				typeof refund.id !== "string"
			)
				throw new Error("WAFFO_REFUND_BINDING_MISMATCH");
			if (refund.status === "succeeded")
				return {
					status: "SUCCEEDED",
					providerRefundId: refund.id,
					amountMicros: request.amountMicros,
					currency: request.currency,
					occurredAt: paymentDate(refund.createdAt),
				};
			if (refund.status === "failed")
				return { status: "FAILED", providerRefundId: refund.id, error: "WAFFO_REFUND_FAILED" };
			return { status: "PROCESSING", providerRefundId: refund.id };
		}
		if (tickets.length === 1) {
			const ticket = objectRecord(tickets[0]);
			const requestedAmount = objectRecord(objectRecord(ticket.versionData).requestedAmount);
			if (
				ticket.subjectId !== payment.providerPaymentId ||
				ticket.refundTicketMerchantExternalId !== request.providerRequestId ||
				paymentDecimalMicros(requestedAmount.amount) !== request.amountMicros ||
				paymentCurrency(requestedAmount.currency) !== request.currency
			)
				throw new Error("WAFFO_REFUND_BINDING_MISMATCH");
			if (ticket.status === "rejected") return { status: "FAILED", error: "WAFFO_REFUND_REJECTED" };
			return { status: "PROCESSING" };
		}
		return { status: "UNKNOWN", error: "WAFFO_REFUND_CONFIRMATION_PENDING" };
	}
	return {
		name: "waffo",
		async verifyPayment(payment) {
			assertEnvironment(payment);
			const response = await boundary.query({
				query: `query AdminRefundPayment($storeId: String!, $paymentId: String!) {
					payments(storeId: $storeId, limit: 2, filter: { id: { eq: $paymentId } }) {
						id orderId status testMode amount { display currency } refundedAmount { display currency }
						onetimeOrder { id storeId testMode orderMerchantExternalId merchantProvidedBuyerIdentity }
						subscriptionOrder { id storeId testMode orderMerchantExternalId merchantProvidedBuyerIdentity }
					}
				}`,
				variables: { storeId, paymentId: payment.providerPaymentId },
			});
			const payments = response.data?.payments;
			if (
				response.errors?.length ||
				response.warnings?.length ||
				!Array.isArray(payments) ||
				payments.length !== 1
			)
				throw new Error("WAFFO_REFUND_PAYMENT_UNCONFIRMED");
			const remote = objectRecord(payments[0]);
			const amount = objectRecord(remote.amount);
			const refunded = objectRecord(remote.refundedAmount);
			const order = objectRecord(
				payment.productKind === "PLAN" ? remote.subscriptionOrder : remote.onetimeOrder,
			);
			if (
				remote.id !== payment.providerPaymentId ||
				remote.orderId !== payment.providerOrderId ||
				remote.status !== "succeeded" ||
				remote.testMode !== (mode === "test") ||
				order.id !== payment.providerOrderId ||
				order.storeId !== storeId ||
				order.testMode !== (mode === "test") ||
				order.orderMerchantExternalId !== payment.checkoutIntentId ||
				paymentDecimalMicros(amount.display) !== payment.amountMicros ||
				paymentCurrency(amount.currency) !== payment.currency ||
				paymentDecimalMicros(refunded.display) !== payment.refundedAmountMicros ||
				paymentCurrency(refunded.currency) !== payment.currency
			)
				throw new Error("WAFFO_REFUND_PAYMENT_MISMATCH");
		},
		async submit(payment, request) {
			assertEnvironment(payment);
			const response = await boundary.createTicket({
				paymentId: payment.providerPaymentId,
				reason: request.reason || "Administrator requested full remaining payment refund.",
				requestedAmount: {
					amount: refundDecimalAmount(request.amountMicros),
					currency: request.currency,
				},
				refundTicketMerchantExternalId: request.providerRequestId,
			});
			// Ticket approval or execution timestamps never stand in for a refund.
			if (response.status < 200 || response.status >= 300)
				return { status: "UNKNOWN", error: "WAFFO_REFUND_SUBMISSION_UNCONFIRMED" };
			try {
				return await inspect(payment, request);
			} catch {
				return { status: "PROCESSING", error: "WAFFO_REFUND_CONFIRMATION_PENDING" };
			}
		},
		inspect,
	};
}
