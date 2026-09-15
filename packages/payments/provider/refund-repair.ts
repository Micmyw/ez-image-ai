import { runSerializable, type Prisma } from "@repo/database";

import { normalizeProviderPaymentEvent } from "./lifecycle-normalization";

// Only events rejected by the old unsupported-refund implementation are eligible.
// Correlation, signature, amount and ownership errors keep their existing fences.
export async function requeuePreviouslyUnsupportedRefunds(
	client: Parameters<typeof runSerializable>[0],
	limit = 100,
) {
	const candidates = await client.paymentEvent.findMany({
		where: {
			provider: { in: ["paypal", "waffo"] },
			status: "DEAD_LETTER",
			failureReason: {
				in: ["PAYMENT_PROVIDER_REFUND_REVIEW_REQUIRED", "PAYMENT_PROVIDER_EVENT_UNSUPPORTED"],
			},
		},
		orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
		take: Math.min(Math.max(limit, 1), 1000),
	});
	let requeued = 0;
	for (const event of candidates) {
		try {
			const normalized = normalizeProviderPaymentEvent(
				event.provider as "paypal" | "waffo",
				event.envelope,
			);
			if (!["PAYMENT_REFUNDED", "CREDIT_PACK_REFUNDED", "NOOP"].includes(normalized.kind)) continue;
		} catch {
			continue;
		}
		requeued += await runSerializable(client, async (tx: Prisma.TransactionClient) => {
			const changed = await tx.paymentEvent.updateMany({
				where: { id: event.id, status: "DEAD_LETTER", failureReason: event.failureReason },
				data: {
					status: "FAILED",
					attemptCount: 0,
					processedAt: null,
					processingToken: null,
					processingLeasedUntil: null,
					failureReason: null,
					lastErrorClass: null,
				},
			});
			if (!changed.count) return 0;
			const dedupeKey = `refund-support-v1:${event.id}`;
			await tx.outboxEvent.upsert({
				where: { dedupeKey },
				create: {
					eventType: "PAYMENT_EVENT_RECEIVED",
					aggregateType: "PAYMENT_EVENT",
					aggregateId: event.id,
					dedupeKey,
					payload: { paymentEventId: event.id },
				},
				update: {},
			});
			await tx.auditLog.create({
				data: {
					action: "PAYMENT_REFUND_SUPPORT_REQUEUED",
					targetType: "PAYMENT_EVENT",
					targetId: event.id,
					before: { status: event.status, failureReason: event.failureReason },
					after: { status: "FAILED", repairVersion: "refund-support-v1" },
					metadata: { provider: event.provider, providerEventId: event.providerEventId },
				},
			});
			return 1;
		});
	}
	return { requeued };
}
