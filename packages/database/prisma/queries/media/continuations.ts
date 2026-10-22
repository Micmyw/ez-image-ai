import type { Prisma } from "../../generated/client";
import { getImagePhaseOwner, type ImagePhaseOwner } from "./image-phase-ownership";
import type { MediaTransactionClient } from "./types";

type Client = MediaTransactionClient | Prisma.TransactionClient;
export interface GenerationContinuation {
	phaseOwner?: ImagePhaseOwner;
	eventIds: string[];
	pollAttemptId?: string;
	notBefore?: number;
}

export interface TerminalMediaVerificationObservation {
	assetId: string;
	kind: "INPUT" | "OUTPUT";
	generation: number;
	status: "READY" | "QUARANTINED" | "VERIFICATION_FAILED" | "DELETED";
	updatedAt: Date;
	deletedAt: Date | null;
	provider: string;
	ruleVersion: string;
	policyVersion: string;
}

export const MEDIA_VERIFICATION_OBSERVATION_SELECT = {
	id: true,
	kind: true,
	status: true,
	updatedAt: true,
	deletedAt: true,
	verificationEngine: true,
	verificationGeneration: true,
	verificationProvider: true,
	verificationRuleVersion: true,
	verificationPolicyVersion: true,
	verificationSubmissionUncertain: true,
	verificationLeaseToken: true,
	verificationLeasedUntil: true,
} as const satisfies Prisma.MediaAssetSelect;

export type MediaVerificationObservationAsset = Prisma.MediaAssetGetPayload<{
	select: typeof MEDIA_VERIFICATION_OBSERVATION_SELECT;
}>;

/** In-process DB admission data; never a field in the task payload or RPC schema. */
export interface MediaVerificationAdmission {
	asset: MediaVerificationObservationAsset | null;
}

/** A read-only terminal observation is not a receipt for a newly committed verdict. */
export async function readTerminalMediaVerificationObservation(
	input: { assetId: string; provider: string; ruleVersion: string; policyVersion: string },
	client: Client,
	admission?: MediaVerificationAdmission,
): Promise<TerminalMediaVerificationObservation | undefined> {
	const asset = admission
		? admission.asset
		: await client.mediaAsset.findUnique({
				where: { id: input.assetId },
				select: MEDIA_VERIFICATION_OBSERVATION_SELECT,
			});
	if (
		!asset ||
		asset.id !== input.assetId ||
		asset.verificationEngine !== "legacy" ||
		asset.verificationGeneration < 1 ||
		asset.verificationProvider !== input.provider ||
		asset.verificationRuleVersion !== input.ruleVersion ||
		asset.verificationPolicyVersion !== input.policyVersion ||
		asset.verificationSubmissionUncertain !== false ||
		asset.verificationLeaseToken !== null ||
		asset.verificationLeasedUntil !== null ||
		!["READY", "QUARANTINED", "VERIFICATION_FAILED", "DELETED"].includes(asset.status)
	)
		return undefined;
	return {
		assetId: asset.id,
		kind: asset.kind,
		generation: asset.verificationGeneration,
		status: asset.status as TerminalMediaVerificationObservation["status"],
		updatedAt: asset.updatedAt,
		deletedAt: asset.deletedAt,
		provider: input.provider,
		ruleVersion: input.ruleVersion,
		policyVersion: input.policyVersion,
	};
}

/** Revalidate the complete observed epoch and read its durable events in one SQL snapshot. */
export async function getObservedAssetGenerationContinuation(
	observed: TerminalMediaVerificationObservation,
	client: Client,
): Promise<GenerationContinuation | undefined> {
	const [result] = await client.$queryRaw<Array<{ matched: boolean; eventIds: string[] }>>`
		WITH observed AS (
			SELECT "id", "kind", "verificationGeneration" FROM "media_asset"
			WHERE "id" = ${observed.assetId} AND "kind"::text = ${observed.kind}
				AND "verificationEngine" = 'legacy'
				AND "verificationGeneration" = ${observed.generation}
				AND "verificationGeneration" >= 1
				AND "status"::text = ${observed.status}
				AND "status"::text IN ('READY', 'QUARANTINED', 'VERIFICATION_FAILED', 'DELETED')
				AND "updatedAt" = ${observed.updatedAt}
				AND "deletedAt" IS NOT DISTINCT FROM ${observed.deletedAt}
				AND "verificationProvider" = ${observed.provider}
				AND "verificationRuleVersion" = ${observed.ruleVersion}
				AND "verificationPolicyVersion" = ${observed.policyVersion}
				AND "verificationSubmissionUncertain" = false
				AND "verificationLeaseToken" IS NULL AND "verificationLeasedUntil" IS NULL
		), jobs AS (
			SELECT DISTINCT binding."jobId", observed.* FROM "generation_job_asset" binding
			JOIN observed ON observed."id" = binding."assetId"
		), keys AS (
			SELECT "jobId", "kind", unnest(CASE WHEN "kind" = 'INPUT' THEN ARRAY[
				'generation-dispatch-after-verification:' || "jobId" || ':' || "id" || ':g' || "verificationGeneration",
				'generation-settle-after-input-verification:' || "jobId" || ':' || "id" || ':g' || "verificationGeneration"
			] ELSE ARRAY[
				'generation-finalize-after-output-verification:' || "jobId" || ':' || "id" || ':g' || "verificationGeneration",
				'generation-settle-after-output-verification:' || "jobId" || ':' || "id" || ':g' || "verificationGeneration",
				'generation-settle:' || "jobId"
			] END) AS "dedupeKey" FROM jobs
		), pending AS (
			SELECT event."id", event."availableAt" FROM keys
			JOIN "outbox_event" event ON event."dedupeKey" = keys."dedupeKey"
				AND event."aggregateId" = keys."jobId"
			WHERE event."status"::text IN ('PENDING', 'LEASED')
				AND event."aggregateType" = 'GENERATION_JOB'
				AND ((keys."kind" = 'INPUT' AND event."eventType" IN ('GENERATION_DISPATCH', 'GENERATION_SETTLE'))
					OR (keys."kind" = 'OUTPUT' AND event."eventType" IN ('GENERATION_FINALIZE_RETRY', 'GENERATION_SETTLE')))
			ORDER BY event."availableAt", event."id" LIMIT 100
		)
		SELECT EXISTS (SELECT 1 FROM observed) AS matched,
			ARRAY(SELECT "id" FROM pending ORDER BY "availableAt", "id") AS "eventIds"
	`;
	return result?.matched ? { eventIds: result.eventIds } : undefined;
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
	const keys = bindings.flatMap(({ jobId }) => [
		...prefixes.map((prefix) => `${prefix}:${jobId}:${assetId}:g${asset.verificationGeneration}`),
		// Fully persisted images can commit finalization in the review transaction.
		// Return its canonical settlement event now, without waiting for a separate
		// finalize task or an unrelated provider-poll continuation to discover it.
		...(asset.kind === "OUTPUT" ? [`generation-settle:${jobId}`] : []),
	]);
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
	// Resolve the committed attempt and its bounded event keys at one fresh
	// snapshot; no retained transaction result can hide a newly committed event.
	const pending = await client.$queryRaw<Array<{ id: string }>>`
		SELECT event."id" FROM "generation_attempt" attempt
		JOIN "outbox_event" event ON event."aggregateId" = attempt."jobId"
			AND event."dedupeKey" IN (
				'generation-finalize:' || attempt."jobId" || ':' || attempt."id",
				'generation-settle:' || attempt."jobId"
			)
		WHERE attempt."id" = ${attemptId} AND event."aggregateType" = 'GENERATION_JOB'
			AND event."status" IN ('PENDING', 'LEASED')
		ORDER BY event."availableAt", event."id" LIMIT 100`;
	return { eventIds: pending.map(({ id }) => id) };
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
	) {
		const phaseOwner = await getImagePhaseOwner(
			{ kind: "generation", attemptId: attempt.id },
			client,
		);
		return { eventIds: [], pollAttemptId: attempt.id, ...(phaseOwner ? { phaseOwner } : {}) };
	}
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
	options: { recoverRetry?: boolean; excludeEventId?: string } = {},
): Promise<GenerationContinuation> {
	const eventIds = await events(
		{ aggregateType: "GENERATION_JOB", aggregateId: jobId, eventType: "GENERATION_SETTLE" },
		client,
	);
	if (!options.recoverRetry) return { eventIds };
	const job = await client.generationJob.findUnique({
		where: { id: jobId, executionEngine: "legacy" },
		select: {
			status: true,
			version: true,
			nextFinalizeAt: true,
			finalizationStage: true,
			finalizationRetryCount: true,
			finalizationErrorCode: true,
		},
	});
	if (!job || job.status !== "FINALIZING" || !job.nextFinalizeAt || !job.finalizationStage)
		return { eventIds };
	// A lost processed response resumes only the retry matching the job's current
	// committed schedule. Older/current receipts and other jobs cannot join it.
	const dedupeKey = ["OUTPUT_TRANSFER_IN_PROGRESS", "OUTPUT_TRANSFER_FENCE_LOST"].includes(
		job.finalizationErrorCode ?? "",
	)
		? { startsWith: `generation-finalize-transfer-wait:${jobId}:` }
		: job.finalizationErrorCode === "STORAGE_TRANSFER_EXHAUSTED"
			? { startsWith: `generation-finalize-after-transfer-exhaustion:${jobId}:` }
			: `generation-finalize-retry:${jobId}:${job.finalizationStage.toLowerCase()}:${job.finalizationRetryCount}`;
	const retry = await client.outboxEvent.findMany({
		where: {
			aggregateType: "GENERATION_JOB",
			aggregateId: jobId,
			eventType: "GENERATION_FINALIZE_RETRY",
			dedupeKey,
			status: { in: ["PENDING", "LEASED"] },
			availableAt: job.nextFinalizeAt,
			payload: { path: ["version"], equals: job.version },
			...(options.excludeEventId ? { id: { not: options.excludeEventId } } : {}),
		},
		select: { id: true, availableAt: true },
		take: 2,
	});
	// A legacy ambiguous schedule remains recoverable by its existing recovery
	// policy; never guess which of two committed identities belongs to this turn.
	if (retry.length !== 1) return { eventIds };
	return {
		eventIds: [...new Set([...eventIds, retry[0]!.id])],
		notBefore: retry[0]!.availableAt.getTime(),
	};
}
