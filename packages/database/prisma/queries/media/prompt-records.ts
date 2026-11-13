import { createHash } from "node:crypto";

import type { Prisma } from "../../generated/client";
import type { MediaDatabaseClient } from "./types";

export interface MediaPromptRecord {
	id: string;
	prompt: string;
	productKey: string;
	source: "REFERENCE_DRAFT" | "GENERATION_JOB" | "BLOCKED_REQUEST";
	createdAt: Date;
	jobId: string | null;
}

/** Private diagnostic context only: never changes asset review or generation eligibility. */
export async function saveReferencePromptRecord(
	input: {
		ownerId: string;
		assetId: string;
		productKey: string;
		prompt: string;
		captureId: string;
	},
	client: MediaDatabaseClient,
) {
	if (!input.prompt.trim() || input.prompt.length > 10_000) throw new Error("INVALID_PROMPT");
	const asset = await client.mediaAsset.findFirst({
		where: {
			id: input.assetId,
			ownerType: "USER",
			ownerId: input.ownerId,
			kind: { in: ["INPUT", "OUTPUT"] },
			mimeType: { startsWith: "image/" },
			deletedAt: null,
			finalizedAt: { not: null },
			status: { not: "DELETED" },
		},
		select: { id: true },
	});
	if (!asset) throw new Error("NOT_FOUND");
	const id = `prompt_${digest([input.ownerId, input.captureId])}`;
	const fingerprint = digest([input.assetId, input.productKey, input.prompt]);
	const saved = await client.auditLog.upsert({
		where: { id },
		create: {
			id,
			actorUserId: input.ownerId,
			action: "MEDIA_REFERENCE_PROMPT_SAVED",
			targetType: "MEDIA_ASSET",
			targetId: asset.id,
			metadata: {
				schemaVersion: 1,
				source: "REFERENCE_DRAFT",
				prompt: input.prompt,
				productKey: input.productKey,
				fingerprint,
			},
		},
		// Replays never rewrite a previously captured prompt or its timestamp.
		update: {},
		select: { id: true, metadata: true },
	});
	if (object(saved.metadata)?.fingerprint !== fingerprint) throw new Error("IDEMPOTENCY_CONFLICT");
	return { id: saved.id };
}

export async function getAssetPromptRecords(assetId: string, client: MediaDatabaseClient) {
	const [drafts, bindings] = await Promise.all([
		client.auditLog.findMany({
			where: {
				action: "MEDIA_REFERENCE_PROMPT_SAVED",
				targetType: "MEDIA_ASSET",
				targetId: assetId,
			},
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			take: 10,
			select: { id: true, metadata: true, createdAt: true },
		}),
		client.generationJobAsset.findMany({
			where: { assetId },
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			take: 10,
			select: {
				job: { select: { id: true, inputSnapshot: true, productKey: true, createdAt: true } },
			},
		}),
	]);
	const records: MediaPromptRecord[] = [];
	for (const draft of drafts) {
		const data = object(draft.metadata);
		const prompt = readPrompt(data);
		if (prompt && data?.source === "REFERENCE_DRAFT" && typeof data.productKey === "string")
			records.push({
				id: draft.id,
				prompt,
				productKey: data.productKey,
				source: "REFERENCE_DRAFT",
				createdAt: draft.createdAt,
				jobId: null,
			});
	}
	for (const { job } of bindings) {
		const prompt = readPrompt(object(job.inputSnapshot));
		if (prompt && !records.some((record) => record.jobId === job.id))
			records.push({
				id: job.id,
				prompt,
				productKey: job.productKey,
				source: "GENERATION_JOB",
				createdAt: job.createdAt,
				jobId: job.id,
			});
	}
	return records.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 20);
}

export async function getBlockedPromptRecords(fingerprint: string, client: MediaDatabaseClient) {
	const rows = await client.auditLog.findMany({
		where: {
			action: "MEDIA_TEXT_MODERATION_BLOCKED",
			targetType: "GENERATION_QUOTE_REQUEST",
			targetId: fingerprint,
		},
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		take: 10,
		select: { id: true, metadata: true, createdAt: true },
	});
	return rows.flatMap((row): MediaPromptRecord[] => {
		const data = object(row.metadata);
		const prompt = readPrompt(data);
		return prompt && typeof data?.productKey === "string"
			? [
					{
						id: row.id,
						prompt,
						productKey: data.productKey,
						source: "BLOCKED_REQUEST",
						createdAt: row.createdAt,
						jobId: null,
					},
				]
			: [];
	});
}

function object(value: Prisma.JsonValue): Prisma.JsonObject | null {
	return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function readPrompt(value: Prisma.JsonObject | null): string | null {
	return typeof value?.prompt === "string" && value.prompt.length <= 10_000 && value.prompt.trim()
		? value.prompt
		: null;
}

function digest(value: string[]): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
