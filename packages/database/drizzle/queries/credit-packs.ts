import { and, desc, eq, lt, or } from "drizzle-orm";

import { db } from "../client";
import { creditPackAdjustment, creditPackFulfillment } from "../schema/postgres";

export interface CreditPackFulfillmentCursor {
	fulfilledAt: Date;
	id: string;
}

export interface CreditPackFulfillmentPageInput {
	cursor?: CreditPackFulfillmentCursor | null;
	limit?: number;
}

export async function getCreditPackFulfillmentByCheckoutIntentId(checkoutIntentId: string) {
	const [row] = await db
		.select()
		.from(creditPackFulfillment)
		.where(eq(creditPackFulfillment.checkoutIntentId, checkoutIntentId))
		.limit(1);
	return row ?? null;
}

export async function getCreditPackFulfillmentByProviderPaymentId(
	provider: string,
	providerPaymentId: string,
) {
	const [row] = await db
		.select()
		.from(creditPackFulfillment)
		.where(
			and(
				eq(creditPackFulfillment.provider, provider),
				eq(creditPackFulfillment.providerPaymentId, providerPaymentId),
			),
		)
		.limit(1);
	return row ?? null;
}

export async function getCreditPackFulfillmentByProviderOrderId(
	provider: string,
	providerOrderId: string,
) {
	const [row] = await db
		.select()
		.from(creditPackFulfillment)
		.where(
			and(
				eq(creditPackFulfillment.provider, provider),
				eq(creditPackFulfillment.providerOrderId, providerOrderId),
			),
		)
		.limit(1);
	return row ?? null;
}

export async function getCreditPackAdjustmentByProviderId(
	provider: string,
	providerAdjustmentId: string,
) {
	const [row] = await db
		.select()
		.from(creditPackAdjustment)
		.where(
			and(
				eq(creditPackAdjustment.provider, provider),
				eq(creditPackAdjustment.providerAdjustmentId, providerAdjustmentId),
			),
		)
		.limit(1);
	return row ?? null;
}

export function listCreditPackFulfillmentsByUserId(
	userId: string,
	input: CreditPackFulfillmentPageInput = {},
) {
	return listCreditPackFulfillments("USER", userId, input);
}

export function listCreditPackFulfillmentsByOrganizationId(
	organizationId: string,
	input: CreditPackFulfillmentPageInput = {},
) {
	return listCreditPackFulfillments("ORGANIZATION", organizationId, input);
}

async function listCreditPackFulfillments(
	ownerType: "USER" | "ORGANIZATION",
	ownerId: string,
	input: CreditPackFulfillmentPageInput,
) {
	const limit = boundedLimit(input.limit);
	const cursorFilter = input.cursor
		? or(
				lt(creditPackFulfillment.fulfilledAt, input.cursor.fulfilledAt),
				and(
					eq(creditPackFulfillment.fulfilledAt, input.cursor.fulfilledAt),
					lt(creditPackFulfillment.id, input.cursor.id),
				),
			)
		: undefined;
	const rows = await db
		.select()
		.from(creditPackFulfillment)
		.where(
			and(
				eq(creditPackFulfillment.ownerType, ownerType),
				eq(creditPackFulfillment.ownerId, ownerId),
				cursorFilter,
			),
		)
		.orderBy(desc(creditPackFulfillment.fulfilledAt), desc(creditPackFulfillment.id))
		.limit(limit + 1);
	const items = rows.slice(0, limit);
	const last = rows.length > limit ? items[items.length - 1] : undefined;
	return {
		items,
		nextCursor: last ? { fulfilledAt: last.fulfilledAt, id: last.id } : null,
	};
}

function boundedLimit(limit: number | undefined): number {
	return Number.isInteger(limit) && limit! > 0 ? Math.min(limit!, 100) : 20;
}
