import { createHash } from "node:crypto";

import { ORPCError } from "@orpc/server";
import { getPaymentCheckoutIntentForOwner, ingestPaymentEvent } from "@repo/database";
import { db } from "@repo/database/client";
import { logger } from "@repo/logs";
import { getPaymentProvider, isPaymentProviderConfigured } from "@repo/payments";
import { config as paymentsConfig } from "@repo/payments/config";
import type { CapturedCheckoutEvent } from "@repo/payments/types";
import { z } from "zod";

import { protectedProcedure } from "../../../orpc/procedures";
import { verifyOrganizationBillingManagement } from "../../organizations/lib/membership";

export const capturePayPalCreditPackCheckoutInputSchema = z
	.object({
		intentId: z.string().trim().min(1).max(128),
		providerOrderId: z.string().trim().min(1).max(128),
	})
	.strict();

export const capturePayPalCreditPackCheckout = protectedProcedure
	.route({
		method: "POST",
		path: "/payments/paypal/credit-pack-checkout/capture",
		tags: ["Payments"],
		summary: "Capture a PayPal credit-pack checkout",
		description: "Captures an owner-scoped PayPal order and queues its verified payment event",
	})
	.input(capturePayPalCreditPackCheckoutInputSchema)
	.output(z.object({ accepted: z.literal(true), replayed: z.boolean() }))
	.handler(async ({ input, context: { session, user } }) => {
		const owner = await resolveCaptureOwner(user.id, session.activeOrganizationId);
		const intent = await getPaymentCheckoutIntentForOwner(
			{ intentId: input.intentId, ...owner },
			db,
		);
		if (
			!intent ||
			intent.provider !== "paypal" ||
			intent.productKind !== "CREDIT_PACK" ||
			intent.billingPlan.productKind !== "CREDIT_PACK"
		) {
			throw new ORPCError("NOT_FOUND");
		}
		const trustedOrderId = intent.providerOrderId ?? intent.providerSessionId;
		if (!trustedOrderId || trustedOrderId !== input.providerOrderId) {
			throw new ORPCError("NOT_FOUND");
		}
		if (intent.status === "COMPLETED" && intent.creditPackFulfillment) {
			return { accepted: true as const, replayed: true };
		}
		if (intent.status !== "PROVIDER_PENDING") throw new ORPCError("CONFLICT");
		if (!isPaymentProviderConfigured("paypal")) throw new ORPCError("NOT_FOUND");

		let captured: CapturedCheckoutEvent;
		try {
			const provider = getPaymentProvider("paypal");
			if (!provider?.captureCheckout) throw new Error("PAYPAL_CAPTURE_UNAVAILABLE");
			captured = await provider.captureCheckout({
				providerOrderId: trustedOrderId,
				idempotencyKey: payPalCaptureIdempotencyKey(intent.id, trustedOrderId),
			});
			if (!isCorrelatedPayPalCapture(captured, intent.id, trustedOrderId)) {
				throw new Error("PAYPAL_CAPTURE_CORRELATION_INVALID");
			}
			const receivedAt = new Date();
			const persisted = await ingestPaymentEvent(
				{
					provider: "paypal",
					providerEventId: captured.providerEventId,
					normalizedTransactionId: captured.normalizedTransactionId,
					verifiedAt: receivedAt,
					receivedAt,
					envelope: captured.envelope as never,
				},
				db,
			);
			return { accepted: true as const, replayed: persisted.replayed };
		} catch (error) {
			logger.error(
				{ provider: "paypal", errorClass: captureErrorClass(error) },
				"PayPal credit-pack capture failed",
			);
			throw new ORPCError("INTERNAL_SERVER_ERROR");
		}
	});

async function resolveCaptureOwner(
	userId: string,
	activeOrganizationId: string | null | undefined,
) {
	if (paymentsConfig.billingAttachedTo === "user") {
		return { ownerType: "USER" as const, ownerId: userId };
	}
	if (!activeOrganizationId) throw new ORPCError("FORBIDDEN");
	const membership = await verifyOrganizationBillingManagement(activeOrganizationId, userId);
	if (!membership || membership.organization.id !== activeOrganizationId) {
		throw new ORPCError("FORBIDDEN");
	}
	return { ownerType: "ORGANIZATION" as const, ownerId: activeOrganizationId };
}

function payPalCaptureIdempotencyKey(intentId: string, providerOrderId: string): string {
	return `cp-${createHash("sha256")
		.update(`${intentId}\0${providerOrderId}`)
		.digest("hex")
		.slice(0, 35)}`;
}

function isCorrelatedPayPalCapture(
	captured: CapturedCheckoutEvent,
	intentId: string,
	providerOrderId: string,
): boolean {
	const envelope = recordValue(captured.envelope);
	const resource = recordValue(envelope?.resource);
	const supplementaryData = recordValue(resource?.supplementary_data);
	const relatedIds = recordValue(supplementaryData?.related_ids);
	return Boolean(
		captured.normalizedTransactionId &&
		captured.providerEventId === `capture-response:${captured.normalizedTransactionId}` &&
		stringValue(envelope?.id) === captured.providerEventId &&
		stringValue(envelope?.event_type) === "PAYMENT.CAPTURE.COMPLETED" &&
		stringValue(resource?.id) === captured.normalizedTransactionId &&
		stringValue(resource?.status) === "COMPLETED" &&
		stringValue(resource?.custom_id) === intentId &&
		stringValue(relatedIds?.order_id) === providerOrderId,
	);
}

function recordValue(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function captureErrorClass(error: unknown): string {
	const message = error instanceof Error ? error.message : "";
	return message.startsWith("PAYPAL_CAPTURE_") ? message : "PAYPAL_CAPTURE_FAILED";
}
