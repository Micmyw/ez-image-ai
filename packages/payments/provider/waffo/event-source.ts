import {
	eventRecord,
	SUPPORTED_WAFFO_BILLING_EVENTS,
	type ProviderEventPage,
	type ProviderEventWindow,
} from "../event-source";
import { getWaffoEventId } from "./event-id";
import type { WaffoSdkBoundary } from "./waffo";

// Read the provider's original HTTP delivery payload, including failed deliveries.
// Fields/filters were verified against its authenticated GraphQL schema.
export async function listWaffoPaymentEvents(
	client: Pick<WaffoSdkBoundary, "graphql">,
	configuration: { storeId: string; environment: "test" | "prod" },
	window: ProviderEventWindow,
): Promise<ProviderEventPage> {
	if (!client.graphql) throw new Error("WAFFO_RECONCILIATION_UNAVAILABLE");
	const offset = window.cursor === null ? 0 : Number(window.cursor);
	if (!Number.isSafeInteger(offset) || offset < 0)
		throw new Error("WAFFO_RECONCILIATION_CURSOR_INVALID");
	const result = await client.graphql.query<Record<string, unknown>>({
		query: `query BillingEventBackfill($storeId: String!, $filter: WebhookDeliveryFilter!, $limit: Int!, $offset: Int!) {
			webhookDeliveries(storeId: $storeId, filter: $filter, limit: $limit, offset: $offset, orderBy: [created_at_asc]) { payload }
			webhookDeliveriesCount(storeId: $storeId, filter: $filter)
		}`,
		variables: {
			storeId: configuration.storeId,
			limit: window.limit,
			offset,
			filter: {
				channel: { eq: "http" },
				createdAt: { gte: window.since.toISOString(), lte: window.until.toISOString() },
			},
		},
	});
	const deliveries = result.data?.webhookDeliveries;
	const count = result.data?.webhookDeliveriesCount;
	if (
		result.errors?.length ||
		result.warnings?.length ||
		!Array.isArray(deliveries) ||
		!Number.isSafeInteger(count) ||
		Number(count) < 0
	)
		throw new Error("WAFFO_RECONCILIATION_RESPONSE_INVALID");
	if (!deliveries.length && offset < Number(count))
		throw new Error("WAFFO_RECONCILIATION_PAGE_INCOMPLETE");
	const events = deliveries.flatMap((delivery) => {
		const row = eventRecord(delivery, "WAFFO_RECONCILIATION_EVENT_INVALID");
		const envelope = eventRecord(
			JSON.parse(String(row.payload)),
			"WAFFO_RECONCILIATION_EVENT_INVALID",
		);
		if (envelope.storeId !== configuration.storeId || envelope.mode !== configuration.environment)
			throw new Error("WAFFO_RECONCILIATION_SCOPE_INVALID");
		if (!SUPPORTED_WAFFO_BILLING_EVENTS.has(String(envelope.eventType))) return [];
		const data = eventRecord(envelope.data, "WAFFO_RECONCILIATION_EVENT_INVALID");
		return [
			{
				providerEventId: getWaffoEventId(envelope),
				...(typeof data.orderId === "string" ? { providerSubscriptionId: data.orderId } : {}),
				envelope,
			},
		];
	});
	const nextOffset = offset + deliveries.length;
	return { events, nextCursor: nextOffset < Number(count) ? String(nextOffset) : null };
}
