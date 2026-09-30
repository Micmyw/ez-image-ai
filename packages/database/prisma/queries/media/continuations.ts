import type { Prisma } from "../../generated/client";
import type { MediaTransactionClient } from "./types";

type Client = MediaTransactionClient | Prisma.TransactionClient;
export interface GenerationContinuation {
	eventIds: string[];
	pollAttemptId?: string;
}

/** Private continuation reads return existing rows, never fabricated event identities. */
async function events(where: Prisma.OutboxEventWhereInput, client: Client): Promise<string[]> {
	return (
		await client.outboxEvent.findMany({
			where: { AND: [where, { status: { in: ["PENDING", "LEASED"] } }] },
			select: { id: true },
			orderBy: [{ availableAt: "asc" }, { id: "asc" }],
			take: 100,
		})
	).map(({ id }) => id);
}

export async function getInitialGenerationEventIds(
	jobId: string,
	client: Client,
): Promise<string[]> {
	const waitingInputs = await client.generationJobAsset.findMany({
		where: { jobId, role: "INPUT", asset: { status: "VERIFYING", deletedAt: null } },
		select: { assetId: true },
	});
	return waitingInputs.length
		? events(
				{
					aggregateType: "MEDIA_ASSET",
					aggregateId: { in: waitingInputs.map(({ assetId }) => assetId) },
					eventType: { in: ["MEDIA_ASSET_VERIFY", "MEDIA_ASSET_MODERATION_REQUESTED"] },
				},
				client,
			)
		: events(
				{
					aggregateType: "GENERATION_JOB",
					aggregateId: jobId,
					eventType: { in: ["JOB_CREATED", "GENERATION_DISPATCH"] },
				},
				client,
			);
}

export async function getAssetGenerationContinuation(
	assetId: string,
	client: Client,
): Promise<GenerationContinuation> {
	const asset = await client.mediaAsset.findUnique({
		where: { id: assetId },
		select: { kind: true, verificationGeneration: true },
	});
	if (!asset) return { eventIds: [] };
	const bindings = await client.generationJobAsset.findMany({
		where: { assetId },
		select: { jobId: true },
	});
	if (!bindings.length) return { eventIds: [] };
	// Look up bounded, indexed domain keys. IDs come only from committed rows.
	const prefixes =
		asset.kind === "INPUT"
			? ["generation-dispatch-after-verification", "generation-settle-after-input-verification"]
			: [
					"generation-finalize-after-output-verification",
					"generation-settle-after-output-verification",
				];
	const keys = bindings.flatMap(({ jobId }) =>
		prefixes.map((prefix) => `${prefix}:${jobId}:${assetId}:g${asset.verificationGeneration}`),
	);
	return {
		eventIds: await events(
			{
				aggregateType: "GENERATION_JOB",
				eventType: {
					in:
						asset.kind === "INPUT"
							? ["GENERATION_DISPATCH", "GENERATION_SETTLE"]
							: ["GENERATION_FINALIZE_RETRY", "GENERATION_SETTLE"],
				},
				dedupeKey: { in: keys },
			},
			client,
		),
	};
}

export async function getAttemptGenerationContinuation(
	attemptId: string,
	client: Client,
): Promise<GenerationContinuation> {
	const attempt = await client.generationAttempt.findUnique({
		where: { id: attemptId },
		select: { jobId: true },
	});
	if (!attempt) return { eventIds: [] };
	return {
		eventIds: await events(
			{
				aggregateType: "GENERATION_JOB",
				aggregateId: attempt.jobId,
				dedupeKey: {
					in: [
						`generation-finalize:${attempt.jobId}:${attemptId}`,
						`generation-settle:${attempt.jobId}`,
					],
				},
			},
			client,
		),
	};
}

export async function getSubmittedGenerationContinuation(
	jobId: string,
	client: Client,
): Promise<GenerationContinuation> {
	const attempt = await client.generationAttempt.findFirst({
		where: { jobId },
		orderBy: { attemptNumber: "desc" },
		select: { id: true, status: true, providerTaskId: true, job: { select: { status: true } } },
	});
	if (!attempt) return { eventIds: [] };
	if (
		attempt.providerTaskId &&
		["SUBMITTED", "RUNNING", "SUBMISSION_UNCERTAIN"].includes(attempt.status) &&
		["SUBMITTING", "PROVIDER_PENDING", "PROVIDER_RUNNING"].includes(attempt.job.status)
	)
		return { eventIds: [], pollAttemptId: attempt.id };
	const next = await getAttemptGenerationContinuation(attempt.id, client);
	return {
		eventIds: [
			...next.eventIds,
			...(await events(
				{ aggregateType: "GENERATION_JOB", aggregateId: jobId, eventType: "GENERATION_DISPATCH" },
				client,
			)),
		],
	};
}

export async function getProviderEventContinuation(
	eventId: string,
	client: Client,
): Promise<GenerationContinuation> {
	const event = await client.providerWebhookEvent.findUnique({
		where: { id: eventId },
		select: { provider: true, providerTaskId: true },
	});
	if (!event?.providerTaskId) return { eventIds: [] };
	const attempt = await client.generationAttempt.findFirst({
		where: { provider: event.provider, providerTaskId: event.providerTaskId },
		select: { id: true },
	});
	return attempt ? getAttemptGenerationContinuation(attempt.id, client) : { eventIds: [] };
}

export async function getFinalizationContinuation(
	jobId: string,
	client: Client,
): Promise<GenerationContinuation> {
	return {
		eventIds: await events(
			{ aggregateType: "GENERATION_JOB", aggregateId: jobId, eventType: "GENERATION_SETTLE" },
			client,
		),
	};
}
