import type { Prisma } from "../../generated/client";
import { lockMediaAssetGenerationBindings } from "./asset-binding-locks";
import { reserveCreditsInTransaction } from "./credits";
import { fingerprintGenerationQuoteSecurityPayload } from "./quotes";
import {
	ACTIVE_GENERATION_JOB_STATUSES,
	canTransition,
	type GenerationJobStatusValue,
} from "./state-machine";
import { lockOwnerStorageUsage } from "./storage-usage-locks";
import type {
	CreateGenerationJobInput,
	CreateGenerationJobResult,
	MediaTransactionClient,
} from "./types";
import { isDatabaseUniqueConflict, runSerializable } from "./types";

export async function getCommittedDailyGenerationCost(
	input: { ownerType: "USER" | "ORGANIZATION"; ownerId: string; now?: Date },
	client: MediaTransactionClient | Prisma.TransactionClient,
): Promise<bigint> {
	const startOfDay = new Date(input.now ?? new Date());
	startOfDay.setUTCHours(0, 0, 0, 0);
	const [result] = await client.$queryRaw<Array<{ total: bigint | null }>>`
		SELECT COALESCE(SUM(quote."costMicros"), 0)::bigint AS "total"
		FROM "generation_job" job
		JOIN "generation_quote" quote ON quote."id" = job."quoteId"
		WHERE job."ownerType" = ${input.ownerType}::"OwnerType"
		  AND job."ownerId" = ${input.ownerId}
		  AND job."createdAt" >= ${startOfDay}`;
	return result?.total ?? 0n;
}

async function findExistingJob(
	input: CreateGenerationJobInput,
	client: MediaTransactionClient | Prisma.TransactionClient,
): Promise<CreateGenerationJobResult | null> {
	const existing = await client.generationJob.findUnique({
		where: {
			ownerType_ownerId_idempotencyKey: {
				ownerType: input.ownerType,
				ownerId: input.ownerId,
				idempotencyKey: input.idempotencyKey,
			},
		},
		include: { reservation: true, editSession: true },
	});
	if (!existing?.reservation) return null;
	if (
		existing.quoteId !== input.quoteId ||
		existing.submittedByUserId !== input.submittedByUserId ||
		!existingJobMatchesEdit(input, existing)
	) {
		throw new Error("IDEMPOTENCY_CONFLICT");
	}
	return {
		job: {
			id: existing.id,
			status: existing.status,
			version: existing.version,
			creditsReserved: existing.creditsReserved,
		},
		reservation: {
			id: existing.reservation.id,
			amount: existing.reservation.amount,
			status: existing.reservation.status,
		},
		replayed: true,
	};
}

export async function createGenerationJobTransaction(
	input: CreateGenerationJobInput,
	client: MediaTransactionClient,
): Promise<CreateGenerationJobResult> {
	if (input.ownerType !== "USER") {
		throw new Error("First-release writes support USER owners only");
	}
	if (!input.idempotencyKey.trim()) throw new Error("Idempotency key is required");
	if (
		input.expectedInputAssets &&
		(input.expectedInputAssets.length !== input.inputAssetIds.length ||
			input.expectedInputAssets.some(
				(expected, position) =>
					expected.assetId !== input.inputAssetIds[position] ||
					!/^[a-f0-9]{64}$/i.test(expected.assetChecksum),
			))
	) {
		throw new Error("ASSET_CONTENT_CHANGED");
	}

	try {
		return await runSerializable(client, async (tx) => {
			if (input.maximumConcurrentJobs !== undefined) {
				if (
					!Number.isSafeInteger(input.maximumConcurrentJobs) ||
					input.maximumConcurrentJobs <= 0
				) {
					throw new Error("Generation concurrency limit must be a positive safe integer");
				}
				await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.ownerType}:${input.ownerId}:generation-concurrency`}, 0))`;
			}
			const quote = await tx.generationQuote.findUnique({ where: { id: input.quoteId } });
			if (
				!quote ||
				quote.ownerType !== input.ownerType ||
				quote.ownerId !== input.ownerId ||
				quote.submittedByUserId !== input.submittedByUserId
			) {
				throw new Error("Quote not found for owner");
			}
			if (quote.expiresAt <= new Date()) throw new Error("Quote expired");
			if (quote.credits <= 0n) throw new Error("Quote credits are invalid");
			if (
				quote.moderationDecision !== "ALLOW" ||
				quote.moderationRuleVersion !== input.expectedModerationRuleVersion ||
				quote.inputFingerprint !== fingerprintGenerationQuoteSecurityPayload(quote)
			) {
				throw new Error("TEXT_MODERATION_EVIDENCE_INVALID");
			}
			const replay = await findExistingJob(input, tx);
			if (replay) return replay;
			if (input.maximumConcurrentJobs !== undefined) {
				const activeJobs = await tx.generationJob.count({
					where: {
						ownerType: input.ownerType,
						ownerId: input.ownerId,
						status: { in: [...ACTIVE_GENERATION_JOB_STATUSES] },
					},
				});
				if (activeJobs >= input.maximumConcurrentJobs) {
					throw new Error("CONCURRENT_JOB_LIMIT_REACHED");
				}
			}
			if (input.maximumStorageBytes !== undefined) {
				if (input.maximumStorageBytes <= 0n) {
					throw new Error("Generation storage quota must be positive");
				}
				await lockOwnerStorageUsage(input, tx);
				const usage = await tx.storageUsageReservation.aggregate({
					where: {
						ownerType: input.ownerType,
						ownerId: input.ownerId,
						status: { in: ["ACTIVE", "COMMITTED"] },
					},
					_sum: { bytes: true },
				});
				if ((usage._sum.bytes ?? 0n) >= input.maximumStorageBytes) {
					throw new Error("STORAGE_QUOTA_EXCEEDED");
				}
			}
			if (input.maximumDailyCostMicros !== undefined) {
				await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.ownerType}:${input.ownerId}:media-daily-budget`}, 0))`;
			}
			if (input.maximumDailyCostMicros !== undefined) {
				const committed = await getCommittedDailyGenerationCost(
					{ ownerType: input.ownerType, ownerId: input.ownerId },
					tx,
				);
				if (committed + quote.costMicros > input.maximumDailyCostMicros) {
					throw new Error("BUDGET_EXCEEDED");
				}
			}
			await lockMediaAssetGenerationBindings(input.inputAssetIds, tx);
			const edit = input.edit;
			if (!edit && imageEditContext(quote.inputSnapshot)) throw new Error("NOT_FOUND");
			const editBinding = edit
				? await resolveImageEditBinding({ ...input, edit }, quote, tx)
				: null;

			const inputAssets = input.inputAssetIds.length
				? await tx.mediaAsset.findMany({
						where: {
							id: { in: input.inputAssetIds },
							ownerType: "USER",
							ownerId: input.ownerId,
							status: "READY",
							checksum: { not: null },
						},
					})
				: [];
			if (
				inputAssets.length !== new Set(input.inputAssetIds).size ||
				inputAssets.some((asset) => !asset.checksum || !/^[a-f0-9]{64}$/i.test(asset.checksum))
			) {
				throw new Error("Every input asset must be READY and owned by the user");
			}
			const now = new Date();
			const moderationEvidence = inputAssets.length
				? await tx.assetModerationResult.findMany({
						where: {
							OR: inputAssets.map((asset) => ({
								assetId: asset.id,
								verificationGeneration: asset.verificationGeneration,
							})),
						},
						orderBy: [{ assetId: "asc" }, { attemptNumber: "desc" }, { createdAt: "desc" }],
					})
				: [];
			const latestEvidenceByAssetId = new Map<string, (typeof moderationEvidence)[number]>();
			for (const evidence of moderationEvidence) {
				if (!latestEvidenceByAssetId.has(evidence.assetId)) {
					latestEvidenceByAssetId.set(evidence.assetId, evidence);
				}
			}
			if (
				inputAssets.some((asset) => {
					const evidence = latestEvidenceByAssetId.get(asset.id);
					return (
						asset.verificationValidUntil === null ||
						asset.verificationValidUntil <= now ||
						evidence?.status !== "APPROVED" ||
						evidence.attemptNumber !== asset.verificationAttemptCount ||
						evidence.assetChecksum !== asset.checksum ||
						evidence.evidenceKind !== asset.kind ||
						evidence.provider !== asset.verificationProvider ||
						evidence.providerTaskId !== asset.verificationProviderTaskId ||
						evidence.ruleVersion !== asset.verificationRuleVersion ||
						evidence.policyVersion !== asset.verificationPolicyVersion ||
						evidence.validUntil === null ||
						evidence.validUntil.getTime() !== asset.verificationValidUntil.getTime() ||
						evidence.validUntil <= now
					);
				})
			) {
				throw new Error("ASSET_MODERATION_EVIDENCE_STALE");
			}
			const currentChecksumById = new Map(
				inputAssets.map((asset) => [asset.id, asset.checksum as string]),
			);
			if (
				input.expectedInputAssets?.some(
					(expected) => currentChecksumById.get(expected.assetId) !== expected.assetChecksum,
				)
			) {
				throw new Error("ASSET_CONTENT_CHANGED");
			}
			if (
				inputAssets.some(
					(asset) =>
						asset.verificationRuleVersion !== input.expectedAssetModerationRuleVersion ||
						asset.verificationPolicyVersion !== input.expectedAssetModerationPolicyVersion,
				)
			) {
				throw new Error("ASSET_MODERATION_EVIDENCE_STALE");
			}
			const inputChecksumById = input.expectedInputAssets
				? new Map(
						input.expectedInputAssets.map(({ assetId, assetChecksum }) => [assetId, assetChecksum]),
					)
				: currentChecksumById;

			const account = await tx.creditAccount.findUnique({
				where: { ownerType_ownerId: { ownerType: input.ownerType, ownerId: input.ownerId } },
			});
			if (!account) throw new Error("Credit account not found");
			const editSession =
				input.edit?.kind === "ROOT"
					? await tx.imageEditSession.create({
							data: {
								ownerType: input.ownerType,
								ownerId: input.ownerId,
								rootAssetId: input.edit.rootAssetId,
							},
						})
					: null;
			const job = await tx.generationJob.create({
				data: {
					ownerType: input.ownerType,
					ownerId: input.ownerId,
					submittedByUserId: input.submittedByUserId,
					quoteId: quote.id,
					idempotencyKey: input.idempotencyKey,
					productKey: quote.productKey,
					catalogVersion: quote.catalogVersion,
					pricingVersion: quote.pricingVersion,
					creditsReserved: quote.credits,
					inputSnapshot: generationJobInputSnapshot(quote.inputSnapshot),
					pricingSnapshot: quote.pricingSnapshot as Prisma.InputJsonValue,
					editSessionId: editSession?.id ?? editBinding?.editSessionId,
					parentJobId: editBinding?.parentJobId,
				},
			});
			const reservation = await reserveCreditsInTransaction(
				{
					accountId: account.id,
					jobId: job.id,
					amount: quote.credits,
					referenceKey: `job:${job.id}:reserve`,
				},
				tx,
			);
			if (inputAssets.length) {
				await tx.generationJobAsset.createMany({
					data: input.inputAssetIds.map((assetId, position) => ({
						jobId: job.id,
						assetId,
						assetChecksum: inputChecksumById.get(assetId)!,
						role: "INPUT",
						position,
					})),
				});
			}
			await tx.outboxEvent.create({
				data: {
					eventType: "JOB_CREATED",
					aggregateType: "GENERATION_JOB",
					aggregateId: job.id,
					dedupeKey: `job:${job.id}:created`,
					payload: { jobId: job.id },
				},
			});
			if (editBinding?.editSessionId) {
				await tx.imageEditSession.update({
					where: { id: editBinding.editSessionId },
					data: { updatedAt: new Date() },
				});
			}
			return {
				job: {
					id: job.id,
					status: job.status,
					version: job.version,
					creditsReserved: job.creditsReserved,
				},
				reservation: {
					id: reservation.id,
					amount: reservation.amount,
					status: reservation.status,
				},
				replayed: false,
			};
		});
	} catch (error) {
		if (isDatabaseUniqueConflict(error)) {
			const replay = await findExistingJob(input, client);
			if (replay) return replay;
		}
		throw error;
	}
}

function existingJobMatchesEdit(
	input: CreateGenerationJobInput,
	existing: {
		editSessionId: string | null;
		parentJobId: string | null;
		editSession: { ownerType: string; ownerId: string; rootAssetId: string } | null;
	},
): boolean {
	if (!input.edit) return existing.editSessionId === null && existing.parentJobId === null;
	if (
		!existing.editSessionId ||
		existing.editSession?.ownerType !== input.ownerType ||
		existing.editSession.ownerId !== input.ownerId
	) {
		return false;
	}
	if (input.edit.kind === "ROOT") {
		return (
			existing.parentJobId === null && existing.editSession.rootAssetId === input.edit.rootAssetId
		);
	}
	if (input.edit.kind === "ROOT_RETRY") {
		return (
			existing.parentJobId === null &&
			existing.editSessionId === input.edit.editSessionId &&
			existing.editSession.rootAssetId === input.edit.rootAssetId
		);
	}
	return (
		existing.parentJobId === input.edit.parentJobId &&
		existing.editSessionId === input.edit.editSessionId
	);
}

async function resolveImageEditBinding(
	input: CreateGenerationJobInput & { edit: NonNullable<CreateGenerationJobInput["edit"]> },
	quote: { productKey: string; inputSnapshot: Prisma.JsonValue },
	tx: Prisma.TransactionClient,
): Promise<{ editSessionId: string | null; parentJobId: string | null }> {
	const sourceAssetId = imageEditSourceAssetId(quote.inputSnapshot);
	const frozenEditContext = imageEditContext(quote.inputSnapshot);
	const expectedSourceAssetId =
		input.edit.kind === "CHILD" ? input.edit.sourceAssetId : input.edit.rootAssetId;
	if (
		!isImageEditProduct(quote.productKey) ||
		sourceAssetId !== expectedSourceAssetId ||
		input.inputAssetIds.length !== 1 ||
		input.inputAssetIds[0] !== expectedSourceAssetId
	) {
		throw new Error("NOT_FOUND");
	}

	if (input.edit.kind === "ROOT" || input.edit.kind === "ROOT_RETRY") {
		if (
			input.edit.kind === "ROOT"
				? frozenEditContext &&
					(frozenEditContext.kind !== "ROOT" ||
						frozenEditContext.rootAssetId !== input.edit.rootAssetId)
				: frozenEditContext?.kind !== "ROOT_RETRY" ||
					frozenEditContext.editSessionId !== input.edit.editSessionId ||
					frozenEditContext.rootAssetId !== input.edit.rootAssetId
		) {
			throw new Error("NOT_FOUND");
		}
		if (input.edit.kind === "ROOT_RETRY") {
			const session = await tx.imageEditSession.findFirst({
				where: {
					id: input.edit.editSessionId,
					ownerType: input.ownerType,
					ownerId: input.ownerId,
					rootAssetId: input.edit.rootAssetId,
				},
				select: { id: true },
			});
			if (!session) throw new Error("NOT_FOUND");
		}
		const rootAsset = await tx.mediaAsset.findFirst({
			where: {
				id: input.edit.rootAssetId,
				ownerType: "USER",
				ownerId: input.ownerId,
			},
			select: { status: true, deletedAt: true, mimeType: true },
		});
		if (!rootAsset) throw new Error("NOT_FOUND");
		if (
			rootAsset.status !== "READY" ||
			rootAsset.deletedAt !== null ||
			!rootAsset.mimeType.startsWith("image/")
		) {
			throw new Error("ASSET_NOT_READY");
		}
		return {
			editSessionId: input.edit.kind === "ROOT_RETRY" ? input.edit.editSessionId : null,
			parentJobId: null,
		};
	}
	if (
		frozenEditContext?.kind !== "CHILD" ||
		frozenEditContext.parentJobId !== input.edit.parentJobId ||
		frozenEditContext.editSessionId !== input.edit.editSessionId ||
		frozenEditContext.sourceAssetId !== input.edit.sourceAssetId
	) {
		throw new Error("NOT_FOUND");
	}

	const parent = await tx.generationJob.findFirst({
		where: {
			id: input.edit.parentJobId,
			ownerType: "USER",
			ownerId: input.ownerId,
		},
		select: {
			status: true,
			productKey: true,
			editSessionId: true,
			editSession: { select: { ownerType: true, ownerId: true } },
			assets: {
				where: { role: "OUTPUT", assetId: input.edit.sourceAssetId },
				select: {
					asset: {
						select: {
							ownerType: true,
							ownerId: true,
							status: true,
							deletedAt: true,
							mimeType: true,
							moderationResults: {
								orderBy: [{ attemptNumber: "desc" }, { createdAt: "desc" }],
								take: 1,
								select: { status: true },
							},
						},
					},
				},
			},
		},
	});
	const output = parent?.assets[0]?.asset;
	if (
		!parent ||
		parent.status !== "SUCCEEDED" ||
		!isImageEditProduct(parent.productKey) ||
		!parent.editSessionId ||
		parent.editSessionId !== input.edit.editSessionId ||
		parent.editSession?.ownerType !== input.ownerType ||
		parent.editSession.ownerId !== input.ownerId ||
		!output ||
		output.ownerType !== input.ownerType ||
		output.ownerId !== input.ownerId ||
		output.status !== "READY" ||
		output.deletedAt !== null ||
		!output.mimeType.startsWith("image/") ||
		output.moderationResults[0]?.status !== "APPROVED"
	) {
		throw new Error("NOT_FOUND");
	}
	return { editSessionId: input.edit.editSessionId, parentJobId: input.edit.parentJobId };
}

type FrozenImageEditContext =
	| { kind: "ROOT"; rootAssetId: string }
	| { kind: "ROOT_RETRY"; editSessionId: string; rootAssetId: string }
	| { kind: "CHILD"; parentJobId: string; editSessionId: string; sourceAssetId: string };

function imageEditContext(inputSnapshot: Prisma.JsonValue): FrozenImageEditContext | null {
	if (!isJsonObject(inputSnapshot)) return null;
	const context = inputSnapshot.editContext;
	if (context === undefined) return null;
	if (!isJsonObject(context)) throw new Error("NOT_FOUND");
	if (context.kind === "ROOT" && typeof context.rootAssetId === "string") {
		return { kind: "ROOT", rootAssetId: context.rootAssetId };
	}
	if (
		context.kind === "ROOT_RETRY" &&
		typeof context.editSessionId === "string" &&
		context.editSessionId &&
		typeof context.rootAssetId === "string" &&
		context.rootAssetId
	) {
		return {
			kind: "ROOT_RETRY",
			editSessionId: context.editSessionId,
			rootAssetId: context.rootAssetId,
		};
	}
	if (
		context.kind === "CHILD" &&
		typeof context.parentJobId === "string" &&
		typeof context.editSessionId === "string" &&
		typeof context.sourceAssetId === "string"
	) {
		return {
			kind: "CHILD",
			parentJobId: context.parentJobId,
			editSessionId: context.editSessionId,
			sourceAssetId: context.sourceAssetId,
		};
	}
	throw new Error("NOT_FOUND");
}

function generationJobInputSnapshot(inputSnapshot: Prisma.JsonValue): Prisma.InputJsonValue {
	if (!isJsonObject(inputSnapshot)) return inputSnapshot as Prisma.InputJsonValue;
	const { editContext: _editContext, ...generationInput } = inputSnapshot;
	return generationInput as Prisma.InputJsonObject;
}

function isJsonObject(value: Prisma.JsonValue | undefined): value is Prisma.JsonObject {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function imageEditSourceAssetId(inputSnapshot: Prisma.JsonValue): string | null {
	if (!inputSnapshot || typeof inputSnapshot !== "object" || Array.isArray(inputSnapshot))
		return null;
	const input = inputSnapshot as Record<string, unknown>;
	return input.kind === "image-to-image" && typeof input.sourceAssetId === "string"
		? input.sourceAssetId
		: null;
}

function isImageEditProduct(productKey: string): boolean {
	return productKey === "image-fast" || productKey === "image-quality";
}

export interface TransitionGenerationJobInput {
	jobId: string;
	expectedStatuses: GenerationJobStatusValue[];
	expectedVersion: number;
	nextStatus: GenerationJobStatusValue;
	failureCode?: string;
	failureMessage?: string;
}

export async function transitionGenerationJob(
	input: TransitionGenerationJobInput,
	client: MediaTransactionClient,
) {
	if (
		!input.expectedStatuses.some((status) => canTransition(status, input.nextStatus)) ||
		input.expectedStatuses.some((status) => !canTransition(status, input.nextStatus))
	) {
		throw new Error("Requested generation job transition is not allowed");
	}
	const terminal = ["SUCCEEDED", "FAILED", "CANCELED"].includes(input.nextStatus);
	const result = await client.generationJob.updateMany({
		where: {
			id: input.jobId,
			status: { in: input.expectedStatuses },
			version: input.expectedVersion,
		},
		data: {
			status: input.nextStatus,
			version: { increment: 1 },
			failureCode: input.failureCode,
			failureMessage: input.failureMessage,
			terminalAt: terminal ? new Date() : undefined,
		},
	});
	return {
		applied: result.count === 1,
		job: await client.generationJob.findUnique({ where: { id: input.jobId } }),
	};
}

export async function listGenerationJobs(
	input: {
		ownerType: "USER" | "ORGANIZATION";
		ownerId: string;
		take?: number;
		cursor?: { createdAt: Date; id: string };
	},
	client: MediaTransactionClient,
) {
	const take = Math.min(Math.max(input.take ?? 20, 1), 100);
	return client.generationJob.findMany({
		where: {
			ownerType: input.ownerType,
			ownerId: input.ownerId,
			...(input.cursor
				? {
						OR: [
							{ createdAt: { lt: input.cursor.createdAt } },
							{ createdAt: input.cursor.createdAt, id: { lt: input.cursor.id } },
						],
					}
				: {}),
		},
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		take,
	});
}
