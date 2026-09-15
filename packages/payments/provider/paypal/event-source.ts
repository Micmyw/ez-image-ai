import {
	eventRecord,
	SUPPORTED_PAYPAL_BILLING_EVENTS,
	type ProviderEventPage,
	type ProviderEventWindow,
} from "../event-source";
import type { PayPalHttpBoundary } from "./paypal";

export async function listPayPalPaymentEvents(
	http: PayPalHttpBoundary,
	configuration: { baseUrl: string; accessToken: string },
	window: ProviderEventWindow,
): Promise<ProviderEventPage> {
	const url = window.cursor
		? checkedCursor(window.cursor, configuration.baseUrl)
		: new URL("/v1/notifications/webhooks-events", configuration.baseUrl);
	if (!window.cursor) {
		url.searchParams.set("start_time", window.since.toISOString().replace(/\.\d{3}Z$/, "Z"));
		url.searchParams.set("end_time", window.until.toISOString().replace(/\.\d{3}Z$/, "Z"));
		url.searchParams.set("page_size", String(Math.min(window.limit, 100)));
	}
	const response = await http.request({
		method: "GET",
		url: url.toString(),
		headers: { Authorization: `Bearer ${configuration.accessToken}` },
	});
	if (response.status !== 200) throw new Error("PAYPAL_RECONCILIATION_RESPONSE_INVALID");
	const body = eventRecord(response.body, "PAYPAL_RECONCILIATION_RESPONSE_INVALID");
	if (!Array.isArray(body.events)) throw new Error("PAYPAL_RECONCILIATION_RESPONSE_INVALID");
	const events = body.events.flatMap((value) => {
		const envelope = eventRecord(value, "PAYPAL_RECONCILIATION_EVENT_INVALID");
		if (!SUPPORTED_PAYPAL_BILLING_EVENTS.has(String(envelope.event_type))) return [];
		if (typeof envelope.id !== "string") throw new Error("PAYPAL_RECONCILIATION_EVENT_INVALID");
		const resource = eventRecord(envelope.resource, "PAYPAL_RECONCILIATION_EVENT_INVALID");
		const subscriptionId = String(envelope.event_type).startsWith("BILLING.SUBSCRIPTION.")
			? resource.id
			: resource.billing_agreement_id;
		return [
			{
				providerEventId: envelope.id,
				...(typeof subscriptionId === "string" ? { providerSubscriptionId: subscriptionId } : {}),
				envelope,
			},
		];
	});
	const links = Array.isArray(body.links) ? body.links : [];
	const next = links
		.map((link) => eventRecord(link, "PAYPAL_RECONCILIATION_RESPONSE_INVALID"))
		.find((link) => link.rel === "next");
	return {
		events,
		nextCursor: next ? checkedCursor(String(next.href), configuration.baseUrl).toString() : null,
	};
}
function checkedCursor(value: string, baseUrl: string): URL {
	const url = new URL(value, baseUrl);
	if (
		url.origin !== new URL(baseUrl).origin ||
		url.pathname !== "/v1/notifications/webhooks-events" ||
		url.username ||
		url.password ||
		url.hash
	)
		throw new Error("PAYPAL_RECONCILIATION_CURSOR_INVALID");
	return url;
}
