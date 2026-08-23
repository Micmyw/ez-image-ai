import { PrismaPg } from "@prisma/adapter-pg";

import type { Prisma } from "../../generated/client";
import { PrismaClient } from "../../generated/client";
import type { GenerationJobStatusValue } from "./state-machine";

export type MediaDatabaseClient = Prisma.TransactionClient;
export type MediaTransactionClient = PrismaClient;

let defaultClient: PrismaClient | undefined;

export function getMediaDatabaseClient(client?: MediaDatabaseClient): MediaDatabaseClient {
	if (client) return client;
	if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
	defaultClient ??= new PrismaClient({
		adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
	});
	return defaultClient;
}

export interface CreateGenerationQuoteInput {
	ownerType: "USER" | "ORGANIZATION";
	ownerId: string;
	submittedByUserId: string;
	productKey: string;
	catalogVersion: string;
	pricingVersion: string;
	credits: bigint;
	costMicros?: bigint;
	inputSnapshot: Prisma.InputJsonValue;
	pricingSnapshot?: Prisma.InputJsonValue;
	expiresAt: Date;
}

export interface CreateModeratedGenerationQuoteInput extends CreateGenerationQuoteInput {
	moderation: {
		decision: "ALLOW" | "REJECT" | "REVIEW" | "ERROR";
		provider: string;
		ruleVersion: string;
		reasonCode: string;
		inputFingerprint: string;
	};
}

export interface CreateGenerationJobInput {
	ownerType: "USER" | "ORGANIZATION";
	ownerId: string;
	submittedByUserId: string;
	quoteId: string;
	idempotencyKey: string;
	inputAssetIds: string[];
	expectedInputAssets?: Array<{ assetId: string; assetChecksum: string }>;
	expectedModerationRuleVersion: string;
	expectedAssetModerationRuleVersion?: string;
	expectedAssetModerationPolicyVersion?: string;
	maximumDailyCostMicros?: bigint;
	maximumStorageBytes?: bigint;
}

export interface CreateGenerationJobResult {
	job: {
		id: string;
		status: GenerationJobStatusValue;
		version: number;
		creditsReserved: bigint;
	};
	reservation: {
		id: string;
		amount: bigint;
		status: "ACTIVE" | "SETTLED" | "RELEASED";
	};
	replayed: boolean;
}

export interface CreditMutationInput {
	reservationId: string;
	amount: bigint;
	referenceKey: string;
}

export interface ReserveCreditsInput {
	accountId: string;
	jobId: string;
	amount: bigint;
	referenceKey: string;
}

export interface CreditGrantInput {
	accountId: string;
	amount: bigint;
	referenceKey: string;
	expiresAt?: Date | null;
	metadata?: Prisma.InputJsonValue;
}

export interface CreditRefundInput {
	accountId: string;
	amount: bigint;
	grantReferenceKey: string;
	referenceKey: string;
	metadata?: Prisma.InputJsonValue;
}

export interface OutboxClaimInput {
	workerId: string;
	limit: number;
	leaseSeconds: number;
	now?: Date;
}

export interface CursorPageInput {
	ownerType: "USER" | "ORGANIZATION";
	ownerId: string;
	take?: number;
	cursor?: { createdAt: Date; id: string };
}

export const SERIALIZABLE_RETRY_LIMIT = 4;

export interface SerializableAttemptEvent {
	attempt: number;
	outcome: "STARTED" | "SERIALIZATION_CONFLICT";
}

export interface SerializableExecutionOptions {
	onAttempt?: (event: SerializableAttemptEvent) => void;
}

interface DatabaseErrorShape {
	name?: string;
	code?: string;
	cause?: {
		originalCode?: string;
		kind?: string;
	};
	meta?: {
		driverAdapterError?: {
			cause?: {
				originalCode?: string;
				kind?: string;
			};
		};
	};
}

function getDatabaseErrorShape(error: unknown): DatabaseErrorShape {
	return error as DatabaseErrorShape;
}

export function isDatabaseUniqueConflict(error: unknown): boolean {
	const details = getDatabaseErrorShape(error);
	const cause = details.meta?.driverAdapterError?.cause ?? details.cause;
	return (
		details.code === "P2002" ||
		(details.name === "DriverAdapterError" && cause?.kind === "UniqueConstraintViolation") ||
		cause?.originalCode === "23505" ||
		cause?.kind === "UniqueConstraintViolation"
	);
}

export function isDatabaseSerializationConflict(error: unknown): boolean {
	const details = getDatabaseErrorShape(error);
	const cause = details.meta?.driverAdapterError?.cause ?? details.cause;
	return (
		details.code === "P2034" ||
		cause?.originalCode === "40001" ||
		cause?.kind === "TransactionWriteConflict"
	);
}

export async function runSerializable<T>(
	client: MediaTransactionClient,
	operation: (tx: Prisma.TransactionClient) => Promise<T>,
	options?: SerializableExecutionOptions,
): Promise<T> {
	for (let attempt = 1; attempt <= SERIALIZABLE_RETRY_LIMIT; attempt += 1) {
		options?.onAttempt?.({ attempt, outcome: "STARTED" });
		try {
			return await client.$transaction(operation, {
				isolationLevel: "Serializable",
				maxWait: 5_000,
				timeout: 20_000,
			});
		} catch (error) {
			if (!isDatabaseSerializationConflict(error) || attempt === SERIALIZABLE_RETRY_LIMIT) {
				throw error;
			}
			options?.onAttempt?.({ attempt, outcome: "SERIALIZATION_CONFLICT" });
		}
	}
	throw new Error("Serializable transaction retry limit exceeded");
}
