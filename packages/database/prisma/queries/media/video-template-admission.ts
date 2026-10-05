import { createHash } from "node:crypto";

import { videoEffectRequestSchema, type VideoEffectRequest } from "@repo/config/video-effects";
import {
	parseVideoEffectTemplateSnapshot,
	type VideoEffectTemplateConfig,
} from "@repo/config/video-effects.server";

import type { MediaDatabaseClient, MediaTransactionClient } from "./types";
import {
	createVideoQuoteRecord,
	createVideoJobRecord,
	findExistingVideoAdmission,
} from "./video-v1";

export type TemplateAdmission = {
	request: VideoEffectRequest;
	template: VideoEffectTemplateConfig;
};
const object = (v: unknown): Record<string, unknown> =>
	v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
export const canonicalVideoTemplateJson = (v: unknown): string =>
	JSON.stringify(v, (_k, x) =>
		x && typeof x === "object" && !Array.isArray(x)
			? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)))
			: x,
	);
export function assertTemplateAdmissionSnapshot(
	snapshot: unknown,
	template: TemplateAdmission | undefined,
	compareConfig: boolean,
) {
	const snap = object(snapshot);
	if (!template) {
		if (snap.videoEffectTemplate || snap.videoEffectRequest)
			throw new Error("INVALID_VIDEO_QUOTE_KIND");
		return;
	}
	if (
		!snap.videoEffectTemplate ||
		canonicalVideoTemplateJson(snap.videoEffectRequest) !==
			canonicalVideoTemplateJson(videoEffectRequestSchema.parse(template.request))
	)
		throw new Error("VIDEO_TEMPLATE_QUOTE_INPUT_MISMATCH");
	if (
		compareConfig &&
		canonicalVideoTemplateJson(snap.videoEffectTemplate) !==
			canonicalVideoTemplateJson(parseVideoEffectTemplateSnapshot(template.template))
	)
		throw new Error("VIDEO_TEMPLATE_VERSION_CHANGED");
}
export async function findTemplateRoleInputs(
	ownerId: string,
	request: VideoEffectRequest,
	maximumInputBytes: number,
	tx: MediaDatabaseClient,
	now: Date,
) {
	const assets = [];
	for (const assetId of [request.inputs.leftAssetId, request.inputs.rightAssetId]) {
		const asset = await tx.mediaAsset.findFirst({
			where: {
				id: assetId,
				ownerType: "USER",
				ownerId,
				kind: "INPUT",
				deletedAt: null,
				status: { in: ["VERIFYING", "READY"] },
				finalizedAt: { not: null },
				OR: [{ deleteAfter: null }, { deleteAfter: { gt: now } }],
			},
		});
		if (
			!asset ||
			!asset.objectKey.endsWith(".template-source.template-input.png") ||
			!asset.storageEtag ||
			!asset.checksum ||
			!/^[a-f0-9]{64}$/i.test(asset.checksum) ||
			!["image/jpeg", "image/png"].includes(asset.mimeType) ||
			asset.byteSize <= 0n ||
			asset.byteSize > BigInt(Math.min(10000000, maximumInputBytes)) ||
			!asset.width ||
			!asset.height ||
			(asset.verificationEngine !== "video-workflow-v1" && asset.status !== "READY")
		)
			throw new Error("VIDEO_INPUT_NOT_AVAILABLE");
		assets.push(asset);
	}
	return assets;
}
export async function templateAdmissionData(
	ownerId: string,
	input: TemplateAdmission,
	maximumInputBytes: number,
	tx: MediaDatabaseClient,
	now: Date,
) {
	const request = videoEffectRequestSchema.parse(input.request);
	const template = parseVideoEffectTemplateSnapshot(input.template);
	const assets = await findTemplateRoleInputs(ownerId, request, maximumInputBytes, tx, now);
	return {
		requestKind: "template-video",
		videoEffectRequest: request,
		videoEffectTemplate: template,
		roleInputIdentities: assets.map((asset, i) => ({
			role: i === 0 ? "left" : "right",
			assetId: asset.id,
			checksum: asset.checksum!,
			objectKey: asset.objectKey,
			storageEtag: asset.storageEtag,
			storageVersionId: asset.storageVersionId,
			verificationGeneration: asset.verificationGeneration,
		})),
		templateFingerprint: createHash("sha256")
			.update(canonicalVideoTemplateJson({ ownerId, request, template }))
			.digest("hex"),
	};
}
function internalRequest(input: TemplateAdmission) {
	const t = parseVideoEffectTemplateSnapshot(input.template);
	return {
		productKey: t.video.productKey,
		mode: "image-to-video" as const,
		prompt: t.video.prompt,
		duration: t.video.duration,
		resolution: t.video.resolution,
		aspectRatio: t.video.aspectRatio,
		sound: false as const,
		inputAssetId: input.request.inputs.leftAssetId,
	};
}
type QuoteInput = Omit<Parameters<typeof createVideoQuoteRecord>[0], "request" | "template"> &
	TemplateAdmission;
type JobInput = Omit<Parameters<typeof createVideoJobRecord>[0], "request" | "template"> &
	TemplateAdmission;
export function createVideoTemplateQuoteRecord(input: QuoteInput, db: MediaTransactionClient) {
	return createVideoQuoteRecord(
		{
			...input,
			request: internalRequest(input),
			template: { request: input.request, template: input.template },
		},
		db,
	);
}
export function createVideoTemplateJobRecord(input: JobInput, db: MediaTransactionClient) {
	return createVideoJobRecord(
		{
			...input,
			request: internalRequest(input),
			template: { request: input.request, template: input.template },
		},
		db,
	);
}
export async function findExistingVideoTemplateAdmission(
	input: { ownerId: string; idempotencyKey: string; request: VideoEffectRequest },
	db: MediaDatabaseClient,
) {
	const prior = await db.generationJob.findUnique({
		where: {
			ownerType_ownerId_idempotencyKey: {
				ownerType: "USER",
				ownerId: input.ownerId,
				idempotencyKey: input.idempotencyKey,
			},
		},
	});
	if (!prior) return null;
	const template = parseVideoEffectTemplateSnapshot(
		object(prior.inputSnapshot).videoEffectTemplate,
	);
	return findExistingVideoAdmission(
		{
			...input,
			request: internalRequest({ request: input.request, template }),
			template: { request: input.request, template },
		},
		db,
	);
}
export async function getVideoTemplateJobRecord(
	ownerId: string,
	jobId: string,
	db: MediaDatabaseClient,
) {
	const job = await db.generationJob.findFirst({
		where: {
			id: jobId,
			ownerType: "USER",
			ownerId,
			executionEngine: "video-workflow-v1",
			videoTemplateExecution: { isNot: null },
		},
		include: { videoTemplateExecution: true, videoExecution: true, reservation: true },
	});
	if (!job?.videoExecution || !job.reservation) throw new Error("NOT_FOUND");
	return job;
}
export async function listVideoTemplateJobRecords(
	ownerId: string,
	input: { cursor?: string; limit?: number },
	db: MediaDatabaseClient,
) {
	const limit = Math.min(20, Math.max(1, input.limit ?? 20));
	if (input.cursor) await getVideoTemplateJobRecord(ownerId, input.cursor, db);
	const rows = await db.generationJob.findMany({
		where: {
			ownerType: "USER",
			ownerId,
			executionEngine: "video-workflow-v1",
			videoTemplateExecution: { isNot: null },
		},
		include: { videoTemplateExecution: true, videoExecution: true, reservation: true },
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
		take: limit + 1,
	});
	return {
		rows: rows.slice(0, limit),
		nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
	};
}
export async function getVideoTemplateInputRecord(
	ownerId: string,
	assetId: string,
	db: MediaDatabaseClient,
) {
	const a = await db.mediaAsset.findFirst({
		where: {
			id: assetId,
			ownerType: "USER",
			ownerId,
			kind: "INPUT",
			deletedAt: null,
			finalizedAt: { not: null },
			objectKey: { endsWith: ".template-source.template-input.png" },
			storageEtag: { not: null },
			checksum: { not: null },
			width: { gt: 0 },
			height: { gt: 0 },
			byteSize: { gt: 0n, lte: 10000000n },
			status: { in: ["VERIFYING", "READY"] },
			OR: [{ deleteAfter: null }, { deleteAfter: { gt: new Date() } }],
		},
	});
	return a && a.checksum && /^[a-f0-9]{64}$/i.test(a.checksum) ? a : null;
}
export async function getVideoTemplateAdminRecord(jobId: string, db: MediaDatabaseClient) {
	return db.generationJob.findFirst({
		where: {
			id: jobId,
			executionEngine: "video-workflow-v1",
			videoTemplateExecution: { isNot: null },
		},
		include: {
			videoTemplateExecution: { include: { sceneAsset: true } },
			videoExecution: true,
			reservation: true,
		},
	});
}
/** Reissue preview capability only from checksum-bound template input evidence. */
export async function getVideoTemplateInputReadAuthorization(
	ownerId: string,
	assetId: string,
	db: MediaDatabaseClient,
) {
	const asset = await getVideoTemplateInputRecord(ownerId, assetId, db);
	if (!asset) return null;
	const executions = await db.videoTemplateExecution.findMany({
		where: { job: { ownerType: "USER", ownerId, assets: { some: { assetId, role: "INPUT" } } } },
		orderBy: { createdAt: "desc" },
		take: 20,
	});
	for (const execution of executions) {
		const reviews = object(execution.inputReview);
		const policy = object(execution.templateSnapshot).safetyPolicyVersion;
		for (const role of ["left", "right"]) {
			const r = object(reviews[role]);
			const validUntil = typeof r.validUntil === "string" ? new Date(r.validUntil) : null;
			if (
				object(r.decision).decision === "ALLOW" &&
				r.assetId === asset.id &&
				r.checksum === asset.checksum &&
				r.objectKey === asset.objectKey &&
				r.storageEtag === asset.storageEtag &&
				r.storageVersionId === asset.storageVersionId &&
				r.verificationGeneration === asset.verificationGeneration &&
				r.safetyPolicyVersion === policy &&
				validUntil &&
				validUntil > new Date()
			)
				return {
					id: asset.id,
					objectKey: asset.objectKey,
					verificationValidUntil: validUntil,
					deleteAfter: asset.deleteAfter,
				};
		}
	}
	return null;
}
