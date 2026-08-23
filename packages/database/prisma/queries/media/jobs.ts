import type { Prisma } from "../../generated/client";
import { reserveCreditsInTransaction } from "./credits";
import { fingerprintGenerationQuoteSecurityPayload } from "./quotes";
import { canTransition, type GenerationJobStatusValue } from "./state-machine";
import type {
	CreateGenerationJobInput,
	CreateGenerationJobResult,
	MediaTransactionClient,
} from "./types";
import { runSerializable } from "./types";

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
		include: { reservation: true },
	});
	if (!existing?.reservation) return null;
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

	try {
		return await runSerializable(client, async (tx) => {
			if (input.maximumDailyCostMicros !== undefined) {
				await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.ownerType}:${input.ownerId}:media-daily-budget`}, 0))`;
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
			if (input.maximumDailyCostMicros !== undefined) {
				const committed = await getCommittedDailyGenerationCost(
					{ ownerType: input.ownerType, ownerId: input.ownerId },
					tx,
				);
				if (committed + quote.costMicros > input.maximumDailyCostMicros) {
					throw new Error("BUDGET_EXCEEDED");
				}
			}

			const inputAssets = input.inputAssetIds.length
				? await tx.mediaAsset.findMany({
						where: {
							id: { in: input.inputAssetIds },
							ownerType: "USER",
							ownerId: input.ownerId,
							status: "READY",
						},
					})
				: [];
			if (inputAssets.length !== new Set(input.inputAssetIds).size) {
				throw new Error("Every input asset must be READY and owned by the user");
			}

			const account = await tx.creditAccount.findUnique({
				where: { ownerType_ownerId: { ownerType: input.ownerType, ownerId: input.ownerId } },
			});
			if (!account) throw new Error("Credit account not found");
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
					inputSnapshot: quote.inputSnapshot as Prisma.InputJsonValue,
					pricingSnapshot: quote.pricingSnapshot as Prisma.InputJsonValue,
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
		if ((error as { code?: string }).code === "P2002") {
			const replay = await findExistingJob(input, client);
			if (replay) return replay;
		}
		throw error;
	}
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
