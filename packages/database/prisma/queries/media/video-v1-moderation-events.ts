import { readVideoVisualSafetyProfile } from "@repo/config/video-safety";

import { Prisma as RuntimePrisma } from "#prisma-runtime-client";

import { getDatabaseClient } from "../../client";
import type { Prisma } from "../../generated/client";
import { runSerializable } from "./types";

const ENGINE = "video-workflow-v1";
const PROVIDER = "sightengine-video-v1";
const object = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
export interface VideoModerationEventReference {
	eventId: string;
	replayed: boolean;
	notified: boolean;
	jobId?: string;
	workflowInstanceId?: string;
}

async function resolveMedia(tx: Prisma.TransactionClient, taskId: string) {
	const assets = await tx.mediaAsset.findMany({
		where: {
			verificationEngine: ENGINE,
			verificationProvider: "sightengine",
			verificationProviderTaskId: taskId,
			kind: "OUTPUT",
			deletedAt: null,
		},
		take: 2,
		include: {
			jobBindings: {
				where: { role: "OUTPUT", job: { executionEngine: ENGINE } },
				include: { job: { include: { videoExecution: true } } },
				take: 2,
			},
		},
	});
	if (assets.length !== 1) return null;
	const asset = assets[0]!;
	if (asset.jobBindings.length !== 1 || !asset.checksum || !asset.storageEtag || !asset.finalizedAt)
		return null;
	const job = asset.jobBindings[0]!.job;
	let profile;
	try {
		profile = readVideoVisualSafetyProfile(job.inputSnapshot);
	} catch {
		return null;
	}
	if (
		!job.videoExecution ||
		profile.provider !== "sightengine" ||
		asset.verificationRuleVersion !== profile.ruleVersion ||
		asset.verificationPolicyVersion !== profile.policyVersion ||
		job.ownerType !== asset.ownerType ||
		job.ownerId !== asset.ownerId ||
		job.videoExecution.workflowInstanceId !== `video-v1-${job.id}`
	)
		return null;
	return {
		jobId: job.id,
		workflowInstanceId: job.videoExecution.workflowInstanceId,
		assetId: asset.id,
		checksum: asset.checksum,
		etag: asset.storageEtag,
		visualSafetyContractVersion: profile.contractVersion,
	};
}

/** Store a signed early callback even before the original submit response has been saved. */
export async function persistVideoModerationWebhook(input: {
	taskId: string;
	eventHash: string;
	receivedAt: Date;
}): Promise<VideoModerationEventReference> {
	return runSerializable(getDatabaseClient(), async (tx) => {
		const providerEventId = `video-v1:${input.taskId}:${input.eventHash}`;
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${PROVIDER}:${providerEventId}`}, 0))`;
		const prior = await tx.providerWebhookEvent.findUnique({
			where: { provider_providerEventId: { provider: PROVIDER, providerEventId } },
		});
		const binding = await resolveMedia(tx, input.taskId);
		const envelope = {
			executionEngine: ENGINE,
			taskId: input.taskId,
			notifiedAt: null,
			...binding,
		};
		// A serializable transaction can establish its snapshot while waiting for
		// the advisory lock. A plain find-then-create would then observe no row
		// despite a concurrent committed insert and raise P2002. Use PostgreSQL's
		// unique upsert; a stale snapshot becomes a retriable serialization conflict.
		const event =
			prior ??
			(await tx.providerWebhookEvent.upsert({
				where: { provider_providerEventId: { provider: PROVIDER, providerEventId } },
				create: {
					provider: PROVIDER,
					providerEventId,
					providerTaskId: input.taskId,
					verifiedAt: input.receivedAt,
					receivedAt: input.receivedAt,
					envelope,
				},
				// Do not overwrite verified payload identity or a notification marker.
				update: { providerTaskId: input.taskId },
			}));
		if (prior && binding && !object(prior.envelope).jobId)
			await tx.providerWebhookEvent.update({
				where: { id: prior.id },
				data: { envelope: { ...object(prior.envelope), ...binding } as Prisma.InputJsonValue },
			});
		return {
			eventId: event.id,
			replayed: Boolean(prior),
			notified: typeof object(event.envelope).notifiedAt === "string",
			...(binding ? { jobId: binding.jobId, workflowInstanceId: binding.workflowInstanceId } : {}),
		};
	});
}

/** Bounded indexed inbox recovery; unknown account-level jobs never mutate assets. */
export async function listPendingVideoModerationEvents(
	limit: number,
	jobId?: string,
): Promise<VideoModerationEventReference[]> {
	const db = getDatabaseClient();
	let taskIds: string[] | undefined;
	if (jobId) {
		const assets = await db.mediaAsset.findMany({
			where: {
				verificationEngine: ENGINE,
				verificationProvider: "sightengine",
				jobBindings: { some: { jobId, role: "OUTPUT", job: { executionEngine: ENGINE } } },
			},
			select: { verificationProviderTaskId: true },
			take: 2,
		});
		taskIds = assets.flatMap((asset) =>
			asset.verificationProviderTaskId ? [asset.verificationProviderTaskId] : [],
		);
		if (!taskIds.length) return [];
	}
	const now = new Date();
	const events = await db.providerWebhookEvent.findMany({
		where: {
			provider: PROVIDER,
			status: "RECEIVED",
			envelope: { path: ["notifiedAt"], equals: RuntimePrisma.JsonNull },
			...(taskIds
				? { providerTaskId: { in: taskIds } }
				: { OR: [{ processingLeasedUntil: null }, { processingLeasedUntil: { lte: now } }] }),
		},
		orderBy: { receivedAt: "asc" },
		take: Math.min(100, Math.max(1, limit)),
	});
	const result: VideoModerationEventReference[] = [];
	for (const event of events) {
		if (!event.providerTaskId) continue;
		const bound = await runSerializable(db, async (tx) => {
			const binding = await resolveMedia(tx, event.providerTaskId!);
			if (!binding) {
				await tx.providerWebhookEvent.update({
					where: { id: event.id },
					data:
						event.receivedAt.getTime() < now.getTime() - 86_400_000
							? { status: "IGNORED", failureReason: "VIDEO_MODERATION_UNBOUND_EXPIRED" }
							: { processingLeasedUntil: new Date(now.getTime() + 30_000) },
				});
				return null;
			}
			await tx.providerWebhookEvent.update({
				where: { id: event.id },
				data: { envelope: { ...object(event.envelope), ...binding } as Prisma.InputJsonValue },
			});
			return binding;
		});
		if (bound)
			result.push({
				eventId: event.id,
				jobId: bound.jobId,
				workflowInstanceId: bound.workflowInstanceId,
				replayed: true,
				notified: false,
			});
	}
	return result;
}

export async function markVideoModerationWebhookNotified(eventId: string): Promise<void> {
	await runSerializable(getDatabaseClient(), async (tx) => {
		await tx.$queryRaw`SELECT "id" FROM "provider_webhook_event" WHERE "id" = ${eventId} AND "provider" = ${PROVIDER} FOR UPDATE`;
		const event = await tx.providerWebhookEvent.findFirst({
			where: { id: eventId, provider: PROVIDER },
		});
		if (!event || !object(event.envelope).jobId) throw new Error("VIDEO_MODERATION_EVENT_UNBOUND");
		await tx.providerWebhookEvent.update({
			where: { id: eventId },
			data: {
				envelope: {
					...object(event.envelope),
					notifiedAt: new Date().toISOString(),
				} as Prisma.InputJsonValue,
				processingLeasedUntil: null,
			},
		});
	});
}
