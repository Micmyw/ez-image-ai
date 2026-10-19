import { createHash } from "node:crypto";

import { ORPCError } from "@orpc/server";
import { isImagePassOfferSnapshot } from "@repo/config/image-pass";
import { isImagePassBillingPlan, IMAGE_PASS_AMOUNT_MICROS } from "@repo/config/image-pass.server";
import {
	getPaymentCheckoutIntentForOwner,
	getImagePassPurchaseForCheckoutIntent,
	ingestPaymentEvent,
} from "@repo/database";
import { db } from "@repo/database/client";
import { logger } from "@repo/logs";
import {
	getPaymentProvider,
	isPaymentProviderConfigured,
	normalizeProviderPaymentEvent,
} from "@repo/payments";
import type { CapturedCheckoutEvent } from "@repo/payments/types";
import { z } from "zod";

import { protectedProcedure } from "../../../orpc/procedures";

export const capturePayPalImagePassCheckoutInputSchema = z
	.object({
		intentId: z.string().trim().min(1).max(128),
		providerOrderId: z.string().trim().min(1).max(128),
	})
	.strict();

export const capturePayPalImagePassCheckout = protectedProcedure
	.route({
		method: "POST",
		path: "/payments/paypal/image-pass-checkout/capture",
		tags: ["Payments"],
		summary: "Capture a PayPal image-pass checkout",
		description: "Captures an owner-scoped PayPal order and queues its verified payment event",
	})
	.input(capturePayPalImagePassCheckoutInputSchema)
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
			intent.productKind !== "IMAGE_PASS" ||
			!isImagePassBillingPlan(intent.billingPlan) ||
			!isImagePassOfferSnapshot(intent.imagePassOfferSnapshot)
		) {
			throw new ORPCError("NOT_FOUND");
		}
		const trustedOrderId = intent.providerOrderId ?? intent.providerSessionId;
		if (!trustedOrderId || trustedOrderId !== input.providerOrderId) {
			throw new ORPCError("NOT_FOUND");
		}
		if (
			intent.status === "COMPLETED" &&
			(await getImagePassPurchaseForCheckoutIntent({ checkoutIntentId: intent.id, ...owner }, db))
		) {
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
			if (!isCorrelatedPayPalImagePassCapture(captured, intent.id, trustedOrderId)) {
				throw new Error("PAYPAL_CAPTURE_CORRELATION_INVALID");
			}
			const receivedAt = new Date();
			const persisted = await ingestPaymentEvent(
				{
					provider: "paypal",
					providerEnvironment: process.env.PAYPAL_ENVIRONMENT,
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
				"PayPal image-pass capture failed",
			);
			throw new ORPCError("INTERNAL_SERVER_ERROR");
		}
	});

async function resolveCaptureOwner(userId: string, _activeOrganizationId?: string | null) {
	return { ownerType: "USER" as const, ownerId: userId };
}

function payPalCaptureIdempotencyKey(intentId: string, providerOrderId: string): string {
	return `ip-${createHash("sha256")
		.update(`${intentId}\0${providerOrderId}`)
		.digest("hex")
		.slice(0, 35)}`;
}

export function isCorrelatedPayPalImagePassCapture(
	captured: CapturedCheckoutEvent,
	intentId: string,
	providerOrderId: string,
): boolean {
	const envelope = recordValue(captured.envelope);
	const resource = recordValue(envelope?.resource);
	const supplementaryData = recordValue(resource?.supplementary_data);
	const relatedIds = recordValue(supplementaryData?.related_ids);
	let normalized;
	try {
		normalized = normalizeProviderPaymentEvent("paypal", captured.envelope);
	} catch {
		return false;
	}
	return Boolean(
		normalized.kind === "CREDIT_PACK_PAID" &&
		normalized.fact.amountMicros === IMAGE_PASS_AMOUNT_MICROS &&
		normalized.fact.currency === "USD" &&
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
