import { createHash } from "node:crypto";

import { MODERATION_BYPASS_REASON, MODERATION_MAX_FAILURES } from "@repo/config";

import type { Prisma } from "../../generated/client";
import type { MediaDatabaseClient, MediaTransactionClient } from "./types";
import { getMediaDatabaseClient } from "./types";

export async function getModerationIncidentNotification(incidentId: string) {
	const client = getMediaDatabaseClient();
	if (
		!(await client.moderationIncident.findUnique({
			where: { id: incidentId },
			select: { id: true },
		}))
	)
		return null;
	return {
		admins: await client.user.findMany({
			where: { role: "admin", OR: [{ banned: null }, { banned: false }] },
			select: { id: true },
		}),
	};
}

export interface ModerationOutcome {
	targetType: "QUOTE" | "ASSET" | "TEXT_ATTEMPT";
	targetId: string;
	provider: string;
	stage: "TEXT" | "IMAGE";
	epoch: string;
	failures: number;
	lastErrorCode: string;
	startedAt: Date;
	lastFailureAt: Date;
	status: "RETRYING" | "PENDING_REVIEW" | "APPROVED" | "REJECTED" | "BLOCKED";
	bypassed?: boolean;
	serviceResponded?: boolean;
}

/** Called inside the same transaction as the quote/asset evidence. */
export async function recordModerationOutcome(input: ModerationOutcome, tx: MediaDatabaseClient) {
	const activeKey = `${input.provider}:${input.stage}`;
	await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`moderation-incident:${activeKey}`}, 0))`;
	const existing = await tx.moderationReview.findUnique({
		where: { targetType_targetId: { targetType: input.targetType, targetId: input.targetId } },
	});
	// Old webhook/worker completion cannot overwrite an explicit administrator decision.
	if (
		existing?.resolvedBy &&
		(existing.status === "REJECTED" || existing.attemptEpoch === input.epoch)
	)
		return existing;
	const delta = Math.max(
		0,
		input.failures - (existing?.attemptEpoch === input.epoch ? existing.observedFailures : 0),
	);
	let incident = await tx.moderationIncident.findUnique({ where: { activeKey } });
	if (delta > 0) {
		const errorCode = safeCode(input.lastErrorCode);
		incident = incident
			? await tx.moderationIncident.update({
					where: { id: incident.id },
					data: {
						failureCount: { increment: delta },
						lastFailureAt: new Date(
							Math.max(incident.lastFailureAt.getTime(), input.lastFailureAt.getTime()),
						),
						lastErrorCode: errorCode,
					},
				})
			: await tx.moderationIncident.create({
					data: {
						activeKey,
						provider: input.provider,
						stage: input.stage,
						lastErrorCode: errorCode,
						failureCount: delta,
						firstFailureAt: input.lastFailureAt,
						lastFailureAt: input.lastFailureAt,
					},
				});
		await tx.moderationIncidentTarget.upsert({
			where: {
				incidentId_targetType_targetId: {
					incidentId: incident.id,
					targetType: input.targetType,
					targetId: input.targetId,
				},
			},
			create: { incidentId: incident.id, targetType: input.targetType, targetId: input.targetId },
			update: {},
		});
	}
	let review = existing;
	if (existing || (input.failures > 0 && input.targetType !== "TEXT_ATTEMPT")) {
		const data = {
			provider: input.provider,
			stage: input.stage,
			status:
				existing?.status === "RECHECKING" && input.status === "RETRYING"
					? "RECHECKING"
					: input.status,
			bypassed: Boolean(existing?.bypassed || input.bypassed),
			attemptEpoch: input.epoch,
			observedFailures: input.failures,
			lastErrorCode: safeCode(input.lastErrorCode),
			lastFailureAt: input.lastFailureAt,
			resolvedAt: ["APPROVED", "REJECTED"].includes(input.status) ? new Date() : null,
			resolvedBy: null,
			...(incident && delta > 0 ? { incidentId: incident.id } : {}),
		};
		review = existing
			? await tx.moderationReview.update({
					where: { id: existing.id },
					data: { ...data, failureCount: { increment: delta }, version: { increment: 1 } },
				})
			: await tx.moderationReview.create({
					data: {
						...data,
						targetType: input.targetType,
						targetId: input.targetId,
						firstFailureAt: input.lastFailureAt,
						failureCount: delta,
					},
				});
	}
	if (
		incident &&
		!incident.alertedAt &&
		(input.status === "PENDING_REVIEW" ||
			input.status === "BLOCKED" ||
			incident.failureCount >= MODERATION_MAX_FAILURES)
	) {
		await tx.moderationIncident.update({
			where: { id: incident.id },
			data: { alertedAt: new Date() },
		});
		await enqueueIncidentAlert(tx, incident.id, "OPEN");
	}
	// A successful request predating the latest failure is not proof of recovery.
	const recoverySince =
		input.failures > 0
			? new Date(Math.max(input.startedAt.getTime(), input.lastFailureAt.getTime()))
			: input.startedAt;
	if (
		incident &&
		(input.serviceResponded || ["APPROVED", "REJECTED"].includes(input.status)) &&
		incident.lastFailureAt <= recoverySince
	) {
		await tx.moderationIncident.update({
			where: { id: incident.id },
			data: { status: "RECOVERED", activeKey: null, recoveredAt: new Date() },
		});
		if (incident.alertedAt) await enqueueIncidentAlert(tx, incident.id, "RECOVERED");
	}
	return review;
}

async function enqueueIncidentAlert(tx: MediaDatabaseClient, incidentId: string, state: string) {
	await tx.outboxEvent.upsert({
		where: { dedupeKey: `moderation-incident:${incidentId}:${state}` },
		create: {
			eventType: "MODERATION_INCIDENT_ALERT",
			aggregateType: "MODERATION_INCIDENT",
			aggregateId: incidentId,
			dedupeKey: `moderation-incident:${incidentId}:${state}`,
			payload: { incidentId, state },
		},
		update: {},
	});
}

function safeCode(value: string) {
	return /^[A-Z][A-Z0-9_]{0,95}$/.test(value) ? value : "MODERATION_UNAVAILABLE";
}

export async function recordTextModerationOutcome(
	input: {
		targetType: "QUOTE" | "TEXT_ATTEMPT";
		targetId: string;
		moderation: {
			provider: string;
			decision: string;
			ruleVersion: string;
			retry?: { failures: number; lastErrorCode: string; startedAt: string; lastFailureAt: string };
		};
	},
	tx: MediaDatabaseClient,
) {
	const retry = input.moderation.retry;
	if (!retry) return;
	await recordModerationOutcome(
		{
			targetType: input.targetType,
			targetId: input.targetId,
			provider: input.moderation.provider,
			stage: "TEXT",
			epoch: input.moderation.ruleVersion,
			failures: retry.failures,
			lastErrorCode:
				input.moderation.decision === "REVIEW" ? "CONTENT_REVIEW_REQUIRED" : retry.lastErrorCode,
			startedAt: new Date(retry.startedAt),
			lastFailureAt: new Date(retry.lastFailureAt),
			status:
				input.moderation.decision === "BYPASS"
					? "PENDING_REVIEW"
					: input.moderation.decision === "ALLOW"
						? "APPROVED"
						: input.moderation.decision === "ERROR" || input.moderation.decision === "REVIEW"
							? "BLOCKED"
							: "REJECTED",
			bypassed: input.moderation.decision === "BYPASS",
			serviceResponded: ["ALLOW", "REJECT", "REVIEW"].includes(input.moderation.decision),
		},
		tx,
	);
}

export async function assertQuoteModerationPermitted(
	quote: { id: string; moderationDecision: string; moderationReasonCode: string },
	tx: MediaDatabaseClient,
) {
	await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`moderation-quote:${quote.id}`}, 0))`;
	if (quote.moderationDecision === "ALLOW") return;
	if (
		quote.moderationDecision !== "BYPASS" ||
		quote.moderationReasonCode !== MODERATION_BYPASS_REASON
	)
		throw new Error("TEXT_MODERATION_EVIDENCE_INVALID");
	const review = await tx.moderationReview.findUnique({
		where: { targetType_targetId: { targetType: "QUOTE", targetId: quote.id } },
	});
	if (!review || !["PENDING_REVIEW", "RECHECKING", "APPROVED"].includes(review.status))
		throw new Error("TEXT_MODERATION_EVIDENCE_INVALID");
}

/** Fence output publication against a concurrent prompt rejection. Lock before the asset lease. */
export async function lockAssetPromptReview(
	assetId: string,
	tx: MediaDatabaseClient,
): Promise<boolean> {
	const bindings = await tx.generationJobAsset.findMany({
		where: { assetId, role: "OUTPUT" },
		select: { job: { select: { quoteId: true } } },
	});
	const quoteIds = [...new Set(bindings.map((binding) => binding.job.quoteId))].sort();
	for (const id of quoteIds)
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`moderation-quote:${id}`}, 0))`;
	return Boolean(
		quoteIds.length &&
		(await tx.moderationReview.findFirst({
			where: {
				targetType: "QUOTE",
				targetId: { in: quoteIds },
				status: { in: ["REJECTED", "BLOCKED"] },
			},
			select: { id: true },
		})),
	);
}

export async function getAdminModerationReviewDetail(
	id: string,
	actorUserId: string,
	client: MediaTransactionClient,
) {
	const review = await client.moderationReview.findUnique({ where: { id } });
	if (!review) throw new Error("MODERATION_REVIEW_NOT_FOUND");
	const quote =
		review.targetType === "QUOTE"
			? await client.generationQuote.findUnique({
					where: { id: review.targetId },
					select: { inputSnapshot: true },
				})
			: null;
	const asset =
		review.targetType === "ASSET"
			? await client.mediaAsset.findUnique({
					where: { id: review.targetId },
					select: {
						id: true,
						objectKey: true,
						mimeType: true,
						deletedAt: true,
						checksum: true,
						verificationSubmissionUncertain: true,
						verificationProviderTaskId: true,
					},
				})
			: null;
	await client.auditLog.create({
		data: {
			actorUserId,
			action: "MEDIA_MODERATION_REVIEW_VIEWED",
			targetType: "MODERATION_REVIEW",
			targetId: id,
			metadata: {},
		},
	});
	const snapshot = quote?.inputSnapshot;
	return {
		review,
		prompt:
			snapshot &&
			typeof snapshot === "object" &&
			!Array.isArray(snapshot) &&
			typeof snapshot.prompt === "string"
				? snapshot.prompt
				: null,
		asset: asset && !asset.deletedAt ? asset : null,
	};
}

export interface AdminModerationReviewInput {
	reviewId: string;
	version: number;
	action: "APPROVE" | "REJECT" | "RECHECK";
	reason: string;
	idempotencyKey: string;
	actorUserId: string;
	verification: { provider: string; ruleVersion: string; policyVersion: string };
}

export async function applyAdminModerationReview(
	input: AdminModerationReviewInput,
	client: MediaTransactionClient,
) {
	return client.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`admin-moderation:${input.idempotencyKey}`}, 0))`;
		const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
		const auditId = `moderation-operation:${input.idempotencyKey}`;
		const replay = await tx.auditLog.findFirst({
			where: { targetType: "ADMIN_MEDIA_OPERATION", targetId: auditId },
		});
		if (replay) {
			if ((replay.metadata as { fingerprint?: string })?.fingerprint !== fingerprint)
				throw new Error("IDEMPOTENCY_CONFLICT");
			return {
				reviewId: input.reviewId,
				replayed: true,
				status: (replay.after as { status: string }).status,
			};
		}
		const review = await tx.moderationReview.findUnique({ where: { id: input.reviewId } });
		if (!review) throw new Error("MODERATION_REVIEW_NOT_FOUND");
		if (review.targetType === "QUOTE")
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`moderation-quote:${review.targetId}`}, 0))`;
		if (review.targetType === "ASSET") {
			const promptRejected = await lockAssetPromptReview(review.targetId, tx);
			if (promptRejected && input.action !== "REJECT")
				throw new Error("MODERATION_PROMPT_REJECTED");
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-verification:${review.targetId}`}, 0))`;
		}
		if (
			review.version !== input.version ||
			!["PENDING_REVIEW", "BLOCKED", "RECHECKING"].includes(review.status)
		)
			throw new Error("MODERATION_REVIEW_CHANGED");
		if (review.targetType === "TEXT_ATTEMPT")
			throw new Error("MODERATION_REVIEW_TARGET_UNAVAILABLE");
		const now = new Date();
		if (
			review.status === "RECHECKING" &&
			input.action === "RECHECK" &&
			review.updatedAt.getTime() > now.getTime() - 120_000
		)
			throw new Error("MODERATION_RECHECK_IN_PROGRESS");
		const status =
			input.action === "RECHECK"
				? "RECHECKING"
				: input.action === "APPROVE"
					? "APPROVED"
					: "REJECTED";
		const changed = await tx.moderationReview.updateMany({
			where: { id: review.id, version: input.version },
			data: {
				status,
				version: { increment: 1 },
				resolvedAt: input.action === "RECHECK" ? null : now,
				resolvedBy: input.action === "RECHECK" ? null : input.actorUserId,
				resolutionReason: input.reason,
			},
		});
		if (changed.count !== 1) throw new Error("MODERATION_REVIEW_CHANGED");
		if (review.targetType === "ASSET") {
			const asset = await tx.mediaAsset.findUnique({ where: { id: review.targetId } });
			if (!asset || asset.deletedAt || !asset.checksum || !asset.finalizedAt)
				throw new Error("MODERATION_REVIEW_TARGET_UNAVAILABLE");
			if (
				input.action === "APPROVE" &&
				/^(UPLOAD_|LEGACY_UPLOAD_|CHECKSUM_)/.test(asset.verificationLastErrorCode ?? "")
			)
				throw new Error("MODERATION_FILE_INSPECTION_REQUIRED");
			if (input.action === "RECHECK") {
				if (asset.verificationSubmissionUncertain && !asset.verificationProviderTaskId)
					throw new Error("MODERATION_UNCERTAIN_REQUIRES_MANUAL_REVIEW");
				const generation = asset.verificationGeneration + 1;
				await tx.mediaAsset.update({
					where: { id: asset.id },
					data: {
						status: "VERIFYING",
						verificationGeneration: generation,
						verificationAttemptCount: 0,
						verificationProvider: input.verification.provider,
						verificationRuleVersion: input.verification.ruleVersion,
						verificationPolicyVersion: input.verification.policyVersion,
						// Reuse a known detector task. No image generation, reservation, or ledger mutation.
						verificationProviderTaskId:
							asset.verificationProvider === input.verification.provider
								? asset.verificationProviderTaskId
								: null,
						verificationLeaseToken: null,
						verificationLeasedUntil: null,
						verificationNextAttemptAt: null,
						verificationDeadlineAt: null,
						verificationExhaustedAt: null,
						verificationValidUntil: null,
						verificationSubmissionUncertain: false,
						verificationLastErrorCode: null,
						verificationSubmissionToken: null,
						verificationSubmittedAt: null,
					},
				});
				await tx.outboxEvent.create({
					data: {
						eventType: "MEDIA_ASSET_VERIFY",
						aggregateType: "MEDIA_ASSET",
						aggregateId: asset.id,
						dedupeKey: `moderation-review:${review.id}:${input.idempotencyKey}`,
						payload: { assetId: asset.id },
					},
				});
			} else {
				await appendManualAssetDecision(tx, asset, input.action === "APPROVE", input);
			}
		} else if (input.action === "REJECT") {
			await rejectPromptOutputs(tx, review.targetId, review.id);
		}
		await tx.auditLog.create({
			data: {
				actorUserId: input.actorUserId,
				action: `MEDIA_MODERATION_${input.action}`,
				targetType: "ADMIN_MEDIA_OPERATION",
				targetId: auditId,
				before: { reviewId: review.id, status: review.status, version: review.version },
				after: { status, version: input.version + 1 },
				metadata: { reason: input.reason, fingerprint },
			},
		});
		return { reviewId: review.id, replayed: false, status };
	});
}

async function appendManualAssetDecision(
	tx: MediaDatabaseClient,
	asset: Prisma.MediaAssetGetPayload<Record<string, never>>,
	approved: boolean,
	input: AdminModerationReviewInput,
) {
	const attemptNumber = asset.verificationAttemptCount + 1;
	const validUntil = approved ? new Date("9999-12-31T23:59:59.999Z") : null;
	await tx.assetModerationResult.create({
		data: {
			assetId: asset.id,
			assetChecksum: asset.checksum,
			verificationGeneration: asset.verificationGeneration,
			attemptNumber,
			evidenceKind: asset.kind,
			provider: asset.verificationProvider!,
			providerTaskId: asset.verificationProviderTaskId,
			categories: {},
			ruleVersion: asset.verificationRuleVersion!,
			policyVersion: asset.verificationPolicyVersion!,
			status: approved ? "APPROVED" : "REJECTED",
			reasonCode: approved ? "ADMIN_CONTENT_APPROVED" : "ADMIN_CONTENT_REJECTED",
			validUntil,
			rawEnvelope: {
				actorUserId: input.actorUserId,
				reviewId: input.reviewId,
				reason: input.reason,
				manual: true,
			},
		},
	});
	await tx.mediaAsset.update({
		where: { id: asset.id },
		data: {
			status: approved ? "READY" : "QUARANTINED",
			verificationAttemptCount: attemptNumber,
			verificationValidUntil: validUntil,
			verificationLeaseToken: null,
			verificationLeasedUntil: null,
			verificationNextAttemptAt: null,
			verificationLastErrorCode: approved ? null : "ADMIN_CONTENT_REJECTED",
		},
	});
	// Resume only existing unfinished work. Already settled jobs remain financially immutable.
	const bindings = await tx.generationJobAsset.findMany({
		where: {
			assetId: asset.id,
			job: { status: { in: ["RESERVED", "DISPATCH_QUEUED", "FINALIZING"] } },
		},
		include: { job: true },
	});
	for (const binding of bindings) {
		await tx.outboxEvent.upsert({
			where: { dedupeKey: `moderation-resume:${input.idempotencyKey}:${binding.jobId}` },
			create: {
				eventType:
					binding.job.status === "FINALIZING" ? "GENERATION_SETTLE" : "GENERATION_DISPATCH",
				aggregateType: "GENERATION_JOB",
				aggregateId: binding.jobId,
				dedupeKey: `moderation-resume:${input.idempotencyKey}:${binding.jobId}`,
				payload: { jobId: binding.jobId, version: binding.job.version },
			},
			update: {},
		});
	}
}

export async function acknowledgeModerationIncident(
	input: { incidentId: string; actorUserId: string; reason: string },
	client: MediaTransactionClient,
) {
	return client.$transaction(async (tx) => {
		const changed = await tx.moderationIncident.updateMany({
			where: { id: input.incidentId, acknowledgedAt: null },
			data: { acknowledgedAt: new Date(), acknowledgedBy: input.actorUserId },
		});
		if (changed.count)
			await tx.auditLog.create({
				data: {
					actorUserId: input.actorUserId,
					action: "MEDIA_MODERATION_INCIDENT_ACKNOWLEDGED",
					targetType: "MODERATION_INCIDENT",
					targetId: input.incidentId,
					metadata: { reason: input.reason },
				},
			});
		return { acknowledged: changed.count === 1 };
	});
}

export async function completeAdminTextRecheck(
	input: {
		reviewId: string;
		version: number;
		moderation: Parameters<typeof recordTextModerationOutcome>[0]["moderation"];
	},
	client: MediaTransactionClient,
) {
	return client.$transaction(async (tx) => {
		const review = await tx.moderationReview.findUniqueOrThrow({ where: { id: input.reviewId } });
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`moderation-quote:${review.targetId}`}, 0))`;
		const current = await tx.moderationReview.findUniqueOrThrow({ where: { id: review.id } });
		if (current.version !== input.version || current.status !== "RECHECKING")
			return { stale: true, status: current.status };
		await recordTextModerationOutcome(
			{
				targetType: "QUOTE",
				targetId: review.targetId,
				moderation: {
					...input.moderation,
					ruleVersion: `${input.moderation.ruleVersion}:review:${input.version}`,
				},
			},
			tx,
		);
		if (input.moderation.decision === "REJECT" || input.moderation.decision === "REVIEW") {
			await rejectPromptOutputs(
				tx,
				review.targetId,
				review.id,
				input.moderation.decision === "REVIEW",
			);
		}
		const completed = await tx.moderationReview.findUniqueOrThrow({
			where: { id: review.id },
			select: { status: true },
		});
		return { stale: false, status: completed.status };
	});
}

async function rejectPromptOutputs(
	tx: MediaDatabaseClient,
	quoteId: string,
	reviewId: string,
	needsReview = false,
) {
	const outputs = await tx.mediaAsset.findMany({
		where: { deletedAt: null, jobBindings: { some: { role: "OUTPUT", job: { quoteId } } } },
		orderBy: { id: "asc" },
		select: { id: true },
	});
	for (const output of outputs) {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-verification:${output.id}`}, 0))`;
		const asset = await tx.mediaAsset.findUniqueOrThrow({ where: { id: output.id } });
		if (needsReview) {
			const target = { targetType: "ASSET", targetId: asset.id };
			const existing = await tx.moderationReview.findUnique({
				where: { targetType_targetId: target },
			});
			if (existing?.status !== "REJECTED") {
				const data = {
					status: "BLOCKED",
					lastErrorCode: "CONTENT_REVIEW_REQUIRED",
					resolvedAt: null,
					resolvedBy: null,
				};
				if (existing)
					await tx.moderationReview.update({
						where: { id: existing.id },
						data: { ...data, version: { increment: 1 } },
					});
				else
					await tx.moderationReview.create({
						data: {
							...target,
							...data,
							provider: asset.verificationProvider ?? "administrator",
							stage: "IMAGE",
							attemptEpoch: String(asset.verificationGeneration),
							firstFailureAt: new Date(),
							lastFailureAt: new Date(),
						},
					});
			}
		}
		const attemptNumber = asset.verificationAttemptCount + 1;
		await tx.assetModerationResult.create({
			data: {
				assetId: asset.id,
				assetChecksum: asset.checksum,
				verificationGeneration: asset.verificationGeneration,
				attemptNumber,
				evidenceKind: asset.kind,
				provider: asset.verificationProvider ?? "administrator",
				providerTaskId: asset.verificationProviderTaskId,
				ruleVersion: asset.verificationRuleVersion ?? "prompt-review",
				policyVersion: asset.verificationPolicyVersion ?? "prompt-review",
				status: "REJECTED",
				reasonCode: "ADMIN_CONTENT_REJECTED",
				categories: {},
				rawEnvelope: { reviewId, source: "prompt-review" },
			},
		});
		await tx.mediaAsset.update({
			where: { id: asset.id },
			data: {
				status: "QUARANTINED",
				verificationAttemptCount: attemptNumber,
				verificationValidUntil: null,
				verificationLeaseToken: null,
				verificationLeasedUntil: null,
				verificationNextAttemptAt: null,
				verificationLastErrorCode: "ADMIN_CONTENT_REJECTED",
			},
		});
	}
}

export async function getAdminModerationOperations(
	input: { limit: number; before?: Date; beforeId?: string; status?: string },
	client: MediaTransactionClient,
) {
	const [incidents, reviews, pendingCount, openCount] = await Promise.all([
		client.moderationIncident.findMany({
			orderBy: { lastFailureAt: "desc" },
			take: input.limit,
			include: { _count: { select: { targets: true } }, targets: { take: 10 } },
		}),
		client.moderationReview.findMany({
			where: {
				...(input.status
					? { status: input.status }
					: { status: { in: ["PENDING_REVIEW", "RECHECKING", "BLOCKED"] } }),
				...(input.before
					? {
							OR: [
								{ updatedAt: { lt: input.before } },
								{ updatedAt: input.before, id: { lt: input.beforeId ?? "" } },
							],
						}
					: {}),
			},
			orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
			take: input.limit + 1,
		}),
		client.moderationReview.count({
			where: { status: { in: ["PENDING_REVIEW", "RECHECKING", "BLOCKED"] } },
		}),
		client.moderationIncident.count({ where: { status: "OPEN" } }),
	]);
	const assetIds = reviews.filter((r) => r.targetType === "ASSET").map((r) => r.targetId);
	const quoteIds = reviews.filter((r) => r.targetType === "QUOTE").map((r) => r.targetId);
	const jobs = await client.generationJob.findMany({
		where: {
			OR: [{ quoteId: { in: quoteIds } }, { assets: { some: { assetId: { in: assetIds } } } }],
		},
		select: { id: true, quoteId: true, assets: { select: { assetId: true } } },
		take: 500,
	});
	const page = reviews.slice(0, input.limit);
	const last = page[page.length - 1];
	return {
		pendingCount,
		openCount,
		nextCursor:
			reviews.length > input.limit && last
				? { before: last.updatedAt.toISOString(), beforeId: last.id }
				: null,
		incidents: incidents.map(({ _count, ...row }) => ({ ...row, affectedTargets: _count.targets })),
		reviews: page.map((r) => ({
			...r,
			jobIds: jobs
				.filter((j) =>
					r.targetType === "QUOTE"
						? j.quoteId === r.targetId
						: j.assets.some((a) => a.assetId === r.targetId),
				)
				.map((j) => j.id),
		})),
	};
}
