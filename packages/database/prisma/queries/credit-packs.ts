import { db } from "../client";
import type { Prisma } from "../generated/client";

type CreditPackReadClient = Pick<
	Prisma.TransactionClient,
	"creditPackAdjustment" | "creditPackFulfillment"
>;

export interface CreditPackFulfillmentCursor {
	fulfilledAt: Date;
	id: string;
}

export interface CreditPackFulfillmentPageInput {
	cursor?: CreditPackFulfillmentCursor | null;
	limit?: number;
}

export function getCreditPackFulfillmentByCheckoutIntentId(
	checkoutIntentId: string,
	client: CreditPackReadClient = db,
) {
	return client.creditPackFulfillment.findUnique({ where: { checkoutIntentId } });
}

export function getCreditPackFulfillmentByProviderPaymentId(
	provider: string,
	providerPaymentId: string,
	client: CreditPackReadClient = db,
) {
	return client.creditPackFulfillment.findUnique({
		where: { provider_providerPaymentId: { provider, providerPaymentId } },
	});
}

export function getCreditPackFulfillmentByProviderOrderId(
	provider: string,
	providerOrderId: string,
	client: CreditPackReadClient = db,
) {
	return client.creditPackFulfillment.findUnique({
		where: { provider_providerOrderId: { provider, providerOrderId } },
	});
}

export function getCreditPackAdjustmentByProviderId(
	provider: string,
	providerAdjustmentId: string,
	client: CreditPackReadClient = db,
) {
	return client.creditPackAdjustment.findUnique({
		where: { provider_providerAdjustmentId: { provider, providerAdjustmentId } },
	});
}

export function listCreditPackFulfillmentsByUserId(
	userId: string,
	input: CreditPackFulfillmentPageInput = {},
	client: CreditPackReadClient = db,
) {
	return listCreditPackFulfillments("USER", userId, input, client);
}

export function listCreditPackFulfillmentsByOrganizationId(
	organizationId: string,
	input: CreditPackFulfillmentPageInput = {},
	client: CreditPackReadClient = db,
) {
	return listCreditPackFulfillments("ORGANIZATION", organizationId, input, client);
}

async function listCreditPackFulfillments(
	ownerType: "USER" | "ORGANIZATION",
	ownerId: string,
	input: CreditPackFulfillmentPageInput,
	client: CreditPackReadClient,
) {
	const limit = boundedLimit(input.limit);
	const rows = await client.creditPackFulfillment.findMany({
		where: {
			ownerType,
			ownerId,
			...(input.cursor
				? {
						OR: [
							{ fulfilledAt: { lt: input.cursor.fulfilledAt } },
							{ fulfilledAt: input.cursor.fulfilledAt, id: { lt: input.cursor.id } },
						],
					}
				: {}),
		},
		orderBy: [{ fulfilledAt: "desc" }, { id: "desc" }],
		take: limit + 1,
	});
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
