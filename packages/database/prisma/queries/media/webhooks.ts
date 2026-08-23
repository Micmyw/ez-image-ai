import type { Prisma } from "../../generated/client";
import type { MediaTransactionClient } from "./types";
import { runSerializable } from "./types";

export interface IngestProviderEventInput {
	provider: string;
	providerEventId: string;
	providerTaskId?: string;
	verifiedAt: Date;
	receivedAt?: Date;
	providerOccurredAt?: Date;
	providerSequence?: bigint;
	envelope: Prisma.InputJsonValue;
}

export async function ingestProviderEvent(
	input: IngestProviderEventInput,
	client: MediaTransactionClient,
) {
	return runSerializable(client, async (tx) => {
		const replay = await tx.providerWebhookEvent.findUnique({
			where: {
				provider_providerEventId: {
					provider: input.provider,
					providerEventId: input.providerEventId,
				},
			},
		});
		if (replay) return { event: replay, replayed: true };
		const event = await tx.providerWebhookEvent.create({ data: input });
		await tx.outboxEvent.create({
			data: {
				eventType: "PROVIDER_EVENT_RECEIVED",
				aggregateType: "PROVIDER_WEBHOOK_EVENT",
				aggregateId: event.id,
				dedupeKey: `provider-event:${input.provider}:${input.providerEventId}`,
				payload: { providerWebhookEventId: event.id },
			},
		});
		return { event, replayed: false };
	});
}

export async function markProviderEventProcessed(id: string, client: MediaTransactionClient) {
	return client.providerWebhookEvent.update({
		where: { id },
		data: { status: "PROCESSED", processedAt: new Date() },
	});
}
