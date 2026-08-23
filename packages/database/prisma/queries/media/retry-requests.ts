import { createHash } from "node:crypto";

import type { Prisma } from "../../generated/client";
import {
	createModeratedGenerationQuote,
	fingerprintGenerationQuoteSecurityPayload,
	type GenerationQuoteSecurityPayload,
} from "./quotes";
import type { CreateModeratedGenerationQuoteInput, MediaTransactionClient } from "./types";

const GENERATION_RETRY_LEASE_MS = 5 * 60 * 1_000;

export interface GenerationRetryOperation {
	sourceJobId: string;
	productKey: string;
	normalizedInput: Prisma.InputJsonValue;
	inputAssets: Array<{ assetId: string; assetChecksum: string }>;
	catalogVersion: string;
	pricingVersion: string;
	credits: string;
	costMicros: string;
	pricingSnapshot: Prisma.InputJsonValue;
	moderationProvider: string;
	moderationRuleVersion: string;
	assetModerationRuleVersion: string;
	assetModerationPolicyVersion: string;
}

export interface ClaimGenerationRetryRequestInput {
	ownerType: "USER" | "ORGANIZATION";
	ownerId: string;
	submittedByUserId: string;
	idempotencyKey: string;
	operation: GenerationRetryOperation;
	now?: Date;
}

export type GenerationRetryRequestClaim =
	| {
			outcome: "CLAIMED";
			requestId: string;
			leaseToken: string;
			operation: GenerationRetryOperation;
			quoteId?: string;
	  }
	| { outcome: "IN_PROGRESS"; requestId: string }
	| { outcome: "SUCCEEDED"; requestId: string; resultJobId: string }
	| { outcome: "FAILED"; requestId: string; errorCode: string };

export function fingerprintGenerationRetryOperation(input: {
	ownerType: "USER" | "ORGANIZATION";
	ownerId: string;
	submittedByUserId: string;
	operation: GenerationRetryOperation;
}): string {
	return createHash("sha256")
		.update(
			stableSerialize({
				ownerType: input.ownerType,
				ownerId: input.ownerId,
				submittedByUserId: input.submittedByUserId,
				operation: input.operation,
			}),
		)
		.digest("hex");
}

export async function resumeGenerationRetryRequest(
	input: {
		ownerType: "USER" | "ORGANIZATION";
		ownerId: string;
		submittedByUserId: string;
		sourceJobId: string;
		idempotencyKey: string;
		now?: Date;
	},
	client: MediaTransactionClient,
): Promise<GenerationRetryRequestClaim | null> {
	if (input.ownerType !== "USER") throw new Error("First-release writes support USER owners only");
	return client.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`generation-retry:${input.ownerType}:${input.ownerId}:${input.idempotencyKey}`}, 0))`;
		const existing = await tx.generationRetryRequest.findUnique({
			where: {
				ownerType_ownerId_idempotencyKey: {
					ownerType: input.ownerType,
					ownerId: input.ownerId,
					idempotencyKey: input.idempotencyKey,
				},
			},
		});
		if (!existing) return null;
		if (
			existing.submittedByUserId !== input.submittedByUserId ||
			existing.sourceJobId !== input.sourceJobId
		) {
			throw new Error("IDEMPOTENCY_CONFLICT");
		}
		if (existing.status === "SUCCEEDED" && existing.resultJobId) {
			return { outcome: "SUCCEEDED", requestId: existing.id, resultJobId: existing.resultJobId };
		}
		if (existing.status === "FAILED") {
			return {
				outcome: "FAILED",
				requestId: existing.id,
				errorCode: existing.errorCode ?? "GENERATION_RETRY_FAILED",
			};
		}
		const operation = parseRetryOperation(existing.operationSnapshot);
		if (
			!operation ||
			existing.operationFingerprint !==
				fingerprintGenerationRetryOperation({
					ownerType: existing.ownerType,
					ownerId: existing.ownerId,
					submittedByUserId: existing.submittedByUserId,
					operation,
				})
		) {
			throw new Error("GENERATION_RETRY_OPERATION_INVALID");
		}
		const claimInput: ClaimGenerationRetryRequestInput = {
			ownerType: existing.ownerType,
			ownerId: existing.ownerId,
			submittedByUserId: existing.submittedByUserId,
			idempotencyKey: existing.idempotencyKey,
			operation,
		};
		const now = input.now ?? new Date();
		const generationJob = await findGenerationJobForRetry(claimInput, tx);
		if (generationJob && isMatchingRecoveredJob(generationJob, existing)) {
			await tx.generationRetryRequest.update({
				where: { id: existing.id },
				data: {
					status: "SUCCEEDED",
					resultJobId: generationJob.id,
					errorCode: null,
					leaseToken: null,
					leasedUntil: null,
					completedAt: now,
				},
			});
			return { outcome: "SUCCEEDED", requestId: existing.id, resultJobId: generationJob.id };
		}
		if (generationJob) {
			await tx.generationRetryRequest.update({
				where: { id: existing.id },
				data: {
					status: "FAILED",
					errorCode: "IDEMPOTENCY_CONFLICT",
					leaseToken: null,
					leasedUntil: null,
					completedAt: now,
				},
			});
			return {
				outcome: "FAILED",
				requestId: existing.id,
				errorCode: "IDEMPOTENCY_CONFLICT",
			};
		}
		if (existing.leasedUntil && existing.leasedUntil > now) {
			return { outcome: "IN_PROGRESS", requestId: existing.id };
		}
		const leaseToken = crypto.randomUUID();
		await tx.generationRetryRequest.update({
			where: { id: existing.id },
			data: {
				leaseToken,
				leasedUntil: new Date(now.getTime() + GENERATION_RETRY_LEASE_MS),
				errorCode: null,
				completedAt: null,
			},
		});
		return {
			outcome: "CLAIMED",
			requestId: existing.id,
			leaseToken,
			operation,
			...(existing.quoteId ? { quoteId: existing.quoteId } : {}),
		};
	});
}

export async function claimGenerationRetryRequest(
	input: ClaimGenerationRetryRequestInput,
	client: MediaTransactionClient,
): Promise<GenerationRetryRequestClaim> {
	if (input.ownerType !== "USER") throw new Error("First-release writes support USER owners only");
	if (!input.idempotencyKey.trim()) throw new Error("Idempotency key is required");
	assertValidRetryOperation(input.operation);
	const operationFingerprint = fingerprintGenerationRetryOperation(input);
	return client.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`generation-retry:${input.ownerType}:${input.ownerId}:${input.idempotencyKey}`}, 0))`;
		const existing = await tx.generationRetryRequest.findUnique({
			where: {
				ownerType_ownerId_idempotencyKey: {
					ownerType: input.ownerType,
					ownerId: input.ownerId,
					idempotencyKey: input.idempotencyKey,
				},
			},
		});
		const now = input.now ?? new Date();
		if (existing) {
			if (
				existing.submittedByUserId !== input.submittedByUserId ||
				existing.sourceJobId !== input.operation.sourceJobId
			) {
				throw new Error("IDEMPOTENCY_CONFLICT");
			}
			if (existing.status === "SUCCEEDED" && existing.resultJobId) {
				return { outcome: "SUCCEEDED", requestId: existing.id, resultJobId: existing.resultJobId };
			}
			if (existing.status === "FAILED") {
				return {
					outcome: "FAILED",
					requestId: existing.id,
					errorCode: existing.errorCode ?? "GENERATION_RETRY_FAILED",
				};
			}
			if (existing.operationFingerprint !== operationFingerprint) {
				throw new Error("IDEMPOTENCY_CONFLICT");
			}
			const generationJob = await findGenerationJobForRetry(input, tx);
			if (generationJob && isMatchingRecoveredJob(generationJob, existing)) {
				await tx.generationRetryRequest.update({
					where: { id: existing.id },
					data: {
						status: "SUCCEEDED",
						resultJobId: generationJob.id,
						errorCode: null,
						leaseToken: null,
						leasedUntil: null,
						completedAt: now,
					},
				});
				return {
					outcome: "SUCCEEDED",
					requestId: existing.id,
					resultJobId: generationJob.id,
				};
			}
			if (generationJob) {
				await tx.generationRetryRequest.update({
					where: { id: existing.id },
					data: {
						status: "FAILED",
						errorCode: "IDEMPOTENCY_CONFLICT",
						leaseToken: null,
						leasedUntil: null,
						completedAt: now,
					},
				});
				return {
					outcome: "FAILED",
					requestId: existing.id,
					errorCode: "IDEMPOTENCY_CONFLICT",
				};
			}
			if (existing.leasedUntil && existing.leasedUntil > now) {
				return { outcome: "IN_PROGRESS", requestId: existing.id };
			}
			const leaseToken = crypto.randomUUID();
			await tx.generationRetryRequest.update({
				where: { id: existing.id },
				data: {
					status: "PROCESSING",
					errorCode: null,
					leaseToken,
					leasedUntil: new Date(now.getTime() + GENERATION_RETRY_LEASE_MS),
					completedAt: null,
				},
			});
			return {
				outcome: "CLAIMED",
				requestId: existing.id,
				leaseToken,
				operation: input.operation,
				...(existing.quoteId ? { quoteId: existing.quoteId } : {}),
			};
		}
		const generationJob = await findGenerationJobForRetry(input, tx);
		if (generationJob) throw new Error("IDEMPOTENCY_CONFLICT");
		const leaseToken = crypto.randomUUID();
		const request = await tx.generationRetryRequest.create({
			data: {
				ownerType: input.ownerType,
				ownerId: input.ownerId,
				submittedByUserId: input.submittedByUserId,
				sourceJobId: input.operation.sourceJobId,
				idempotencyKey: input.idempotencyKey,
				operationFingerprint,
				operationSnapshot: input.operation as unknown as Prisma.InputJsonValue,
				leaseToken,
				leasedUntil: new Date(now.getTime() + GENERATION_RETRY_LEASE_MS),
			},
		});
		return {
			outcome: "CLAIMED",
			requestId: request.id,
			leaseToken,
			operation: input.operation,
		};
	});
}

export async function createGenerationRetryQuoteCheckpoint(
	input: {
		requestId: string;
		leaseToken: string;
		quote: CreateModeratedGenerationQuoteInput;
		now?: Date;
	},
	client: MediaTransactionClient,
) {
	const now = input.now ?? new Date();
	return client.$transaction(async (tx) => {
		const request = await tx.generationRetryRequest.findFirst({
			where: {
				id: input.requestId,
				status: "PROCESSING",
				leaseToken: input.leaseToken,
				leasedUntil: { gt: now },
			},
		});
		if (!request) throw new Error("GENERATION_RETRY_CLAIM_LOST");
		const operation = parseRetryOperation(request.operationSnapshot);
		if (
			!operation ||
			request.operationFingerprint !==
				fingerprintGenerationRetryOperation({
					ownerType: request.ownerType,
					ownerId: request.ownerId,
					submittedByUserId: request.submittedByUserId,
					operation,
				}) ||
			!quoteMatchesRetryOperation(input.quote, operation, request)
		) {
			throw new Error("GENERATION_RETRY_OPERATION_MISMATCH");
		}
		if (request.quoteId) {
			const checkpoint = await tx.generationQuote.findUnique({ where: { id: request.quoteId } });
			if (
				!checkpoint ||
				checkpoint.inputFingerprint !== fingerprintGenerationQuoteSecurityPayload(checkpoint) ||
				!quoteMatchesRetryOperation(checkpoint, operation, request)
			) {
				throw new Error("GENERATION_RETRY_QUOTE_CHECKPOINT_INVALID");
			}
			return checkpoint;
		}
		const quote = await createModeratedGenerationQuote(input.quote, tx);
		const changed = await tx.generationRetryRequest.updateMany({
			where: {
				id: request.id,
				status: "PROCESSING",
				leaseToken: input.leaseToken,
				leasedUntil: { gt: now },
				quoteId: null,
			},
			data: { quoteId: quote.id },
		});
		if (changed.count !== 1) throw new Error("GENERATION_RETRY_CLAIM_LOST");
		return quote;
	});
}

export async function completeGenerationRetryRequest(
	input: {
		requestId: string;
		leaseToken: string;
		quoteId: string;
		resultJobId: string;
		now?: Date;
	},
	client: MediaTransactionClient,
): Promise<boolean> {
	const now = input.now ?? new Date();
	return client.$transaction(async (tx) => {
		const request = await tx.generationRetryRequest.findFirst({
			where: {
				id: input.requestId,
				status: "PROCESSING",
				leaseToken: input.leaseToken,
				leasedUntil: { gt: now },
				quoteId: input.quoteId,
			},
		});
		if (!request) throw new Error("GENERATION_RETRY_CLAIM_LOST");
		const operation = parseRetryOperation(request.operationSnapshot);
		if (!operation) throw new Error("GENERATION_RETRY_OPERATION_INVALID");
		const resultJob = await findGenerationJobForRetry(
			{
				ownerType: request.ownerType,
				ownerId: request.ownerId,
				submittedByUserId: request.submittedByUserId,
				idempotencyKey: request.idempotencyKey,
				operation,
			},
			tx,
		);
		if (
			!resultJob ||
			resultJob.id !== input.resultJobId ||
			!isMatchingRecoveredJob(resultJob, request)
		) {
			throw new Error("GENERATION_RETRY_RESULT_MISMATCH");
		}
		const changed = await tx.generationRetryRequest.updateMany({
			where: {
				id: request.id,
				status: "PROCESSING",
				leaseToken: input.leaseToken,
				leasedUntil: { gt: now },
				quoteId: input.quoteId,
			},
			data: {
				status: "SUCCEEDED",
				resultJobId: input.resultJobId,
				leaseToken: null,
				leasedUntil: null,
				completedAt: now,
			},
		});
		if (changed.count !== 1) throw new Error("GENERATION_RETRY_CLAIM_LOST");
		return true;
	});
}

export async function failGenerationRetryRequest(
	input: { requestId: string; leaseToken: string; errorCode: string; now?: Date },
	client: MediaTransactionClient,
): Promise<boolean> {
	const now = input.now ?? new Date();
	const changed = await client.generationRetryRequest.updateMany({
		where: {
			id: input.requestId,
			status: "PROCESSING",
			leaseToken: input.leaseToken,
			leasedUntil: { gt: now },
		},
		data: {
			status: "FAILED",
			errorCode: input.errorCode,
			leaseToken: null,
			leasedUntil: null,
			completedAt: now,
		},
	});
	return changed.count === 1;
}

async function findGenerationJobForRetry(
	input: ClaimGenerationRetryRequestInput,
	client: Prisma.TransactionClient,
) {
	return client.generationJob.findUnique({
		where: {
			ownerType_ownerId_idempotencyKey: {
				ownerType: input.ownerType,
				ownerId: input.ownerId,
				idempotencyKey: input.idempotencyKey,
			},
		},
		include: {
			quote: true,
			reservation: true,
			assets: { where: { role: "INPUT" }, orderBy: [{ position: "asc" }, { id: "asc" }] },
		},
	});
}

function isMatchingRecoveredJob(
	job: NonNullable<Awaited<ReturnType<typeof findGenerationJobForRetry>>>,
	request: {
		ownerType: "USER" | "ORGANIZATION";
		ownerId: string;
		submittedByUserId: string;
		sourceJobId: string;
		quoteId: string | null;
		operationFingerprint: string;
		operationSnapshot: Prisma.JsonValue;
		createdAt: Date;
	},
): boolean {
	const operation = parseRetryOperation(request.operationSnapshot);
	if (
		!operation ||
		!request.quoteId ||
		job.quoteId !== request.quoteId ||
		!job.reservation ||
		job.reservation.amount !== job.creditsReserved
	) {
		return false;
	}
	if (
		request.operationFingerprint !==
		fingerprintGenerationRetryOperation({
			ownerType: request.ownerType,
			ownerId: request.ownerId,
			submittedByUserId: request.submittedByUserId,
			operation,
		})
	) {
		return false;
	}
	return (
		job.createdAt >= request.createdAt &&
		job.submittedByUserId === request.submittedByUserId &&
		job.ownerType === request.ownerType &&
		job.ownerId === request.ownerId &&
		job.productKey === operation.productKey &&
		job.catalogVersion === operation.catalogVersion &&
		job.pricingVersion === operation.pricingVersion &&
		job.creditsReserved.toString() === operation.credits &&
		stableSerialize(job.inputSnapshot) === stableSerialize(operation.normalizedInput) &&
		stableSerialize(job.pricingSnapshot) === stableSerialize(operation.pricingSnapshot) &&
		job.quote.ownerType === request.ownerType &&
		job.quote.ownerId === request.ownerId &&
		job.quote.submittedByUserId === request.submittedByUserId &&
		job.quote.productKey === operation.productKey &&
		job.quote.catalogVersion === operation.catalogVersion &&
		job.quote.pricingVersion === operation.pricingVersion &&
		job.quote.credits.toString() === operation.credits &&
		job.quote.costMicros.toString() === operation.costMicros &&
		job.quote.moderationDecision === "ALLOW" &&
		job.quote.moderationProvider === operation.moderationProvider &&
		job.quote.moderationRuleVersion === operation.moderationRuleVersion &&
		job.quote.inputFingerprint === fingerprintGenerationQuoteSecurityPayload(job.quote) &&
		stableSerialize(job.quote.inputSnapshot) === stableSerialize(operation.normalizedInput) &&
		stableSerialize(job.quote.pricingSnapshot) === stableSerialize(operation.pricingSnapshot) &&
		bindingsMatchOperation(job.assets, operation.inputAssets)
	);
}

function bindingsMatchOperation(
	bindings: Array<{ assetId: string; assetChecksum: string }>,
	expected: Array<{ assetId: string; assetChecksum: string }>,
): boolean {
	return (
		bindings.length === expected.length &&
		bindings.every(
			(binding, position) =>
				binding.assetId === expected[position]?.assetId &&
				binding.assetChecksum === expected[position]?.assetChecksum,
		)
	);
}

function quoteMatchesRetryOperation(
	quote:
		| CreateModeratedGenerationQuoteInput
		| (GenerationQuoteSecurityPayload & {
				moderationDecision: string | null;
				moderationProvider: string | null;
				moderationRuleVersion: string | null;
		  }),
	operation: GenerationRetryOperation,
	request: { ownerType: string; ownerId: string; submittedByUserId: string },
): boolean {
	const moderationProvider =
		"moderation" in quote ? quote.moderation.provider : quote.moderationProvider;
	const moderationRuleVersion =
		"moderation" in quote ? quote.moderation.ruleVersion : quote.moderationRuleVersion;
	const moderationDecision =
		"moderation" in quote ? quote.moderation.decision : quote.moderationDecision;
	return (
		quote.ownerType === request.ownerType &&
		quote.ownerId === request.ownerId &&
		quote.submittedByUserId === request.submittedByUserId &&
		quote.productKey === operation.productKey &&
		quote.catalogVersion === operation.catalogVersion &&
		quote.pricingVersion === operation.pricingVersion &&
		quote.credits.toString() === operation.credits &&
		(quote.costMicros ?? 0n).toString() === operation.costMicros &&
		stableSerialize(quote.inputSnapshot) === stableSerialize(operation.normalizedInput) &&
		stableSerialize(quote.pricingSnapshot ?? {}) === stableSerialize(operation.pricingSnapshot) &&
		moderationDecision === "ALLOW" &&
		moderationProvider === operation.moderationProvider &&
		moderationRuleVersion === operation.moderationRuleVersion
	);
}

function assertValidRetryOperation(operation: GenerationRetryOperation): void {
	if (
		!operation.sourceJobId ||
		!operation.productKey ||
		!operation.catalogVersion ||
		!operation.pricingVersion ||
		!/^\d+$/.test(operation.credits) ||
		!/^\d+$/.test(operation.costMicros) ||
		!operation.moderationProvider ||
		!operation.moderationRuleVersion ||
		!operation.assetModerationRuleVersion ||
		!operation.assetModerationPolicyVersion ||
		operation.inputAssets.some(
			(binding) => !binding.assetId || !/^[a-f0-9]{64}$/i.test(binding.assetChecksum),
		) ||
		new Set(operation.inputAssets.map((binding) => binding.assetId)).size !==
			operation.inputAssets.length
	) {
		throw new Error("INVALID_GENERATION_RETRY_OPERATION");
	}
}

function parseRetryOperation(value: Prisma.JsonValue): GenerationRetryOperation | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, Prisma.JsonValue>;
	if (!Array.isArray(record.inputAssets)) return null;
	const inputAssets = record.inputAssets.map((candidate) => {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
		const binding = candidate as Record<string, Prisma.JsonValue>;
		return typeof binding.assetId === "string" && typeof binding.assetChecksum === "string"
			? { assetId: binding.assetId, assetChecksum: binding.assetChecksum }
			: null;
	});
	if (inputAssets.some((binding) => binding === null)) return null;
	const stringFields = [
		"sourceJobId",
		"productKey",
		"catalogVersion",
		"pricingVersion",
		"credits",
		"costMicros",
		"moderationProvider",
		"moderationRuleVersion",
		"assetModerationRuleVersion",
		"assetModerationPolicyVersion",
	] as const;
	if (stringFields.some((field) => typeof record[field] !== "string")) return null;
	if (record.normalizedInput === undefined || record.pricingSnapshot === undefined) return null;
	const operation = {
		sourceJobId: record.sourceJobId as string,
		productKey: record.productKey as string,
		normalizedInput: record.normalizedInput as Prisma.InputJsonValue,
		inputAssets: inputAssets as Array<{ assetId: string; assetChecksum: string }>,
		catalogVersion: record.catalogVersion as string,
		pricingVersion: record.pricingVersion as string,
		credits: record.credits as string,
		costMicros: record.costMicros as string,
		pricingSnapshot: record.pricingSnapshot as Prisma.InputJsonValue,
		moderationProvider: record.moderationProvider as string,
		moderationRuleVersion: record.moderationRuleVersion as string,
		assetModerationRuleVersion: record.assetModerationRuleVersion as string,
		assetModerationPolicyVersion: record.assetModerationPolicyVersion as string,
	};
	try {
		assertValidRetryOperation(operation);
		return operation;
	} catch {
		return null;
	}
}

function stableSerialize(value: unknown): string {
	if (typeof value === "bigint") return JSON.stringify({ $bigint: value.toString() });
	if (value instanceof Date) return JSON.stringify({ $date: value.toISOString() });
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
		.join(",")}}`;
}
