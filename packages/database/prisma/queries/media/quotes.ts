import { createHash } from "node:crypto";

import type { Prisma } from "../../generated/client";
import type { MediaDatabaseClient, MediaTransactionClient } from "./types";
import {
	getMediaDatabaseClient,
	type CreateGenerationQuoteInput,
	type CreateModeratedGenerationQuoteInput,
} from "./types";
export type { CreateGenerationQuoteInput, CreateModeratedGenerationQuoteInput } from "./types";

export async function createGenerationQuote(
	input: CreateGenerationQuoteInput,
	client?: MediaDatabaseClient,
) {
	if (input.ownerType !== "USER") {
		throw new Error("First-release writes support USER owners only");
	}
	if (input.credits <= 0n || input.expiresAt <= new Date()) {
		throw new Error("Quote credits and expiry must be valid");
	}
	return getMediaDatabaseClient(client).generationQuote.create({
		data: {
			...input,
			costMicros: input.costMicros ?? 0n,
			pricingSnapshot: input.pricingSnapshot ?? {},
		},
	});
}

export async function createModeratedGenerationQuoteTransaction(
	input: CreateModeratedGenerationQuoteInput,
	client: MediaTransactionClient,
) {
	validateModeratedGenerationQuote(input);
	return client.$transaction((tx) => createModeratedGenerationQuote(input, tx));
}

export async function createModeratedGenerationQuote(
	input: CreateModeratedGenerationQuoteInput,
	client: MediaDatabaseClient,
) {
	validateModeratedGenerationQuote(input);
	const quote = await client.generationQuote.create({
		data: {
			ownerType: input.ownerType,
			ownerId: input.ownerId,
			submittedByUserId: input.submittedByUserId,
			productKey: input.productKey,
			catalogVersion: input.catalogVersion,
			pricingVersion: input.pricingVersion,
			credits: input.credits,
			costMicros: input.costMicros ?? 0n,
			inputSnapshot: input.inputSnapshot,
			pricingSnapshot: input.pricingSnapshot ?? {},
			expiresAt: input.expiresAt,
			moderationDecision: input.moderation.decision,
			moderationProvider: input.moderation.provider,
			moderationRuleVersion: input.moderation.ruleVersion,
			moderationReasonCode: input.moderation.reasonCode,
			inputFingerprint: input.moderation.inputFingerprint,
		},
	});
	await client.auditLog.create({
		data: {
			actorUserId: input.submittedByUserId,
			action: "MEDIA_TEXT_MODERATION_ALLOWED",
			targetType: "GENERATION_QUOTE",
			targetId: quote.id,
			after: {
				decision: input.moderation.decision,
				provider: input.moderation.provider,
				ruleVersion: input.moderation.ruleVersion,
				reasonCode: input.moderation.reasonCode,
				inputFingerprint: input.moderation.inputFingerprint,
			},
			metadata: {},
		},
	});
	return quote;
}

function validateModeratedGenerationQuote(input: CreateModeratedGenerationQuoteInput): void {
	if (input.ownerType !== "USER") throw new Error("First-release writes support USER owners only");
	if (input.moderation.decision !== "ALLOW") {
		throw new Error(`TEXT_MODERATION_${input.moderation.decision}`);
	}
	if (!/^[a-f0-9]{64}$/.test(input.moderation.inputFingerprint)) {
		throw new Error("TEXT_MODERATION_EVIDENCE_INVALID");
	}
	if (input.moderation.inputFingerprint !== fingerprintGenerationQuoteSecurityPayload(input)) {
		throw new Error("TEXT_MODERATION_EVIDENCE_INVALID");
	}
}

export interface GenerationQuoteSecurityPayload {
	ownerType: "USER" | "ORGANIZATION";
	ownerId: string;
	submittedByUserId: string;
	productKey: string;
	catalogVersion: string;
	pricingVersion: string;
	credits: bigint;
	costMicros?: bigint;
	inputSnapshot: Prisma.InputJsonValue | Prisma.JsonValue;
	pricingSnapshot?: Prisma.InputJsonValue | Prisma.JsonValue;
	expiresAt: Date;
}

export function fingerprintGenerationQuoteSecurityPayload(
	input: GenerationQuoteSecurityPayload,
): string {
	return createHash("sha256")
		.update(
			stableSerialize({
				ownerType: input.ownerType,
				ownerId: input.ownerId,
				submittedByUserId: input.submittedByUserId,
				productKey: input.productKey,
				catalogVersion: input.catalogVersion,
				pricingVersion: input.pricingVersion,
				credits: input.credits,
				costMicros: input.costMicros ?? 0n,
				inputSnapshot: input.inputSnapshot,
				pricingSnapshot: input.pricingSnapshot ?? {},
				expiresAt: input.expiresAt,
			}),
		)
		.digest("hex");
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

export async function getGenerationQuote(id: string, client?: MediaDatabaseClient) {
	return getMediaDatabaseClient(client).generationQuote.findUnique({ where: { id } });
}
