/** Waffo reuses entity IDs across event types; delivery deduplication needs both. */
export function getWaffoEventId(envelope: Record<string, unknown>): string {
	const eventType = envelope.eventType;
	// Older persisted envelopes may only contain id. New ingress requires eventId.
	const eventId = envelope.eventId ?? envelope.id;
	if (typeof eventType !== "string" || !eventType.trim()) {
		throw new Error("WAFFO_EVENT_TYPE_MISSING");
	}
	if (typeof eventId !== "string" || !eventId.trim()) {
		throw new Error("WAFFO_EVENT_ID_MISSING");
	}
	return `${eventType.trim()}:${eventId.trim()}`;
}
