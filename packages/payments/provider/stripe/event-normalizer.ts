import type { Prisma } from "@repo/database";
import type Stripe from "stripe";

import type { StripeBillingSource } from "./billing-source";
import {
	normalizeStripeInvoice,
	normalizeStripeInvoicePayment,
	normalizeStripeInvoicePaymentFailed,
	normalizeStripeRefund,
	normalizeStripeSubscription,
	type StripeBillingFact,
	type StripeInvoicePaymentFact,
} from "./normalization";

const STRIPE_API_VERSION = "2026-07-29.dahlia";

export interface NormalizedStripePaymentEvent {
	eventId: string;
	eventType: string;
	fact: StripeBillingFact | null;
}

export async function normalizeStripePaymentEvent(
	value: Prisma.JsonValue,
	dependencies: { billingSource?: Pick<StripeBillingSource, "listInvoicePayments"> } = {},
): Promise<NormalizedStripePaymentEvent> {
	const envelope = parseEnvelope(value);
	const context = {
		origin: "WEBHOOK" as const,
		changeAt: new Date(envelope.created * 1_000),
		changeId: envelope.id,
	};
	const currentApi = envelope.apiVersion === STRIPE_API_VERSION;

	switch (envelope.type) {
		case "customer.subscription.created":
		case "customer.subscription.updated":
		case "customer.subscription.deleted":
			return {
				eventId: envelope.id,
				eventType: envelope.type,
				fact: normalizeStripeSubscription(
					(currentApi
						? envelope.object
						: adaptLegacySubscription(envelope.object)) as unknown as Stripe.Subscription,
					context,
				),
			};
		case "invoice.paid": {
			const invoice = (currentApi
				? envelope.object
				: adaptLegacyInvoice(envelope.object)) as unknown as Stripe.Invoice;
			let paymentFacts: StripeInvoicePaymentFact[];
			if (dependencies.billingSource) {
				let payments: Awaited<
					ReturnType<NonNullable<typeof dependencies.billingSource>["listInvoicePayments"]>
				>;
				try {
					payments = await dependencies.billingSource.listInvoicePayments(invoice.id);
				} catch {
					// Stripe SDK errors can contain request data. Keep only a stable retry code past
					// this boundary so Trigger/logging never receives the provider error object.
					throw new Error("STRIPE_INVOICE_PAYMENT_SOURCE_FAILURE");
				}
				paymentFacts = payments.map(normalizeStripeInvoicePayment);
			} else if (!currentApi) {
				if (!objectId(envelope.object.subscription)) {
					throw new Error("STRIPE_SUBSCRIPTION_ID_MISSING");
				}
				paymentFacts = [legacyInvoicePaymentFact(envelope.object)];
			} else {
				throw new Error("STRIPE_INVOICE_PAYMENT_SOURCE_REQUIRED");
			}
			return {
				eventId: envelope.id,
				eventType: envelope.type,
				fact: normalizeStripeInvoice(invoice, paymentFacts, context),
			};
		}
		case "invoice.payment_failed":
			return {
				eventId: envelope.id,
				eventType: envelope.type,
				fact: normalizeStripeInvoicePaymentFailed(
					(currentApi
						? envelope.object
						: adaptLegacyInvoice(envelope.object)) as unknown as Stripe.Invoice,
					context,
				),
			};
		case "refund.created":
		case "refund.updated":
		case "refund.failed":
		case "charge.refund.updated":
			return {
				eventId: envelope.id,
				eventType: envelope.type,
				fact: normalizeStripeRefund(envelope.object as unknown as Stripe.Refund, context),
			};
		default:
			return { eventId: envelope.id, eventType: envelope.type, fact: null };
	}
}

interface ParsedEnvelope {
	id: string;
	type: string;
	created: number;
	apiVersion: string | null;
	object: Record<string, unknown>;
}

function parseEnvelope(value: Prisma.JsonValue): ParsedEnvelope {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("STRIPE_EVENT_INVALID");
	}
	const envelope = value as Record<string, unknown>;
	const data = recordValue(envelope.data);
	const object = recordValue(data.object);
	const id = nonemptyString(envelope.id);
	const type = nonemptyString(envelope.type);
	if (
		!id ||
		!type ||
		typeof envelope.created !== "number" ||
		!Number.isSafeInteger(envelope.created) ||
		envelope.created < 0
	) {
		throw new Error("STRIPE_EVENT_INVALID");
	}
	return {
		id,
		type,
		created: envelope.created,
		apiVersion: nonemptyString(envelope.api_version) ?? null,
		object,
	};
}

function adaptLegacySubscription(object: Record<string, unknown>): Record<string, unknown> {
	const items = recordValue(object.items);
	const data = Array.isArray(items.data) ? items.data : [];
	return {
		...object,
		metadata: object.metadata ?? {},
		items: {
			...items,
			data: data.map((value) => {
				const item = recordValue(value);
				return {
					...item,
					current_period_start: item.current_period_start ?? object.current_period_start,
					current_period_end: item.current_period_end ?? object.current_period_end,
				};
			}),
		},
	};
}

function adaptLegacyInvoice(object: Record<string, unknown>): Record<string, unknown> {
	const lines = recordValue(object.lines);
	const data = Array.isArray(lines.data) ? lines.data : [];
	const subscription = objectId(object.subscription);
	return {
		...object,
		currency: object.currency ?? "usd",
		parent:
			object.parent ??
			(subscription
				? {
						type: "subscription_details",
						quote_details: null,
						subscription_details: { subscription, metadata: null },
					}
				: null),
		lines: {
			...lines,
			data: data.map((value) => {
				const line = recordValue(value);
				const priceId = objectId(line.price);
				const lineSubscription = objectId(line.subscription);
				const subscriptionItem = objectId(line.subscription_item);
				const hasExplicitSubscriptionLine =
					lineSubscription !== undefined &&
					subscriptionItem !== undefined &&
					typeof line.proration === "boolean";
				return {
					...line,
					parent:
						line.parent ??
						(hasExplicitSubscriptionLine
							? {
									type: "subscription_item_details",
									invoice_item_details: null,
									subscription_item_details: {
										invoice_item: objectId(line.invoice_item) ?? null,
										proration: line.proration,
										proration_details: line.proration_details ?? null,
										subscription: lineSubscription,
										subscription_item: subscriptionItem,
									},
								}
							: null),
					pricing:
						line.pricing ??
						(priceId
							? {
									type: "price_details",
									price_details: { price: priceId, product: "legacy-unknown" },
									unit_amount_decimal: null,
								}
							: null),
				};
			}),
		},
	};
}

function legacyInvoicePaymentFact(object: Record<string, unknown>): StripeInvoicePaymentFact {
	const invoiceId = objectId(object.id);
	const chargeId = objectId(object.charge);
	const amountPaid = object.amount_paid;
	if (
		!invoiceId ||
		!chargeId ||
		typeof amountPaid !== "number" ||
		!Number.isSafeInteger(amountPaid)
	) {
		throw new Error("STRIPE_INVOICE_PAYMENT_SOURCE_REQUIRED");
	}
	return {
		providerInvoicePaymentId: `legacy:${invoiceId}:${chargeId}`,
		providerChargeId: chargeId,
		providerPaymentIntentId: objectId(object.payment_intent) ?? null,
		amountPaid: BigInt(amountPaid),
	};
}

function recordValue(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function nonemptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function objectId(value: unknown): string | undefined {
	if (typeof value === "string" && value.length > 0) return value;
	if (value && typeof value === "object" && "id" in value && typeof value.id === "string") {
		return value.id || undefined;
	}
	return undefined;
}
