import type { Prisma } from "../../generated/client";
import {
	attemptProjection,
	diagnosticLabels,
	promptReviewProjection,
	safeDiagnosticCode,
	safeDiagnosticIdentifier,
	safeDiagnosticText,
} from "./admin-content-diagnostics";
import { getAssetPromptRecords } from "./prompt-records";
import type { MediaPromptRecord } from "./prompt-records";
import type { MediaTransactionClient } from "./types";

const imageSelect = {
	id: true,
	ownerType: true,
	ownerId: true,
	retentionClass: true,
	kind: true,
	status: true,
	mimeType: true,
	objectKey: true,
	checksum: true,
	finalizedAt: true,
	deletedAt: true,
	createdAt: true,
	verificationGeneration: true,
	verificationAttemptCount: true,
	verificationProvider: true,
	verificationProviderTaskId: true,
	verificationRuleVersion: true,
	verificationPolicyVersion: true,
	verificationLastErrorCode: true,
	moderationResults: {
		orderBy: [{ verificationGeneration: "desc" }, { attemptNumber: "desc" }],
		take: 1,
		select: {
			id: true,
			provider: true,
			providerTaskId: true,
			ruleVersion: true,
			policyVersion: true,
			status: true,
			reasonCode: true,
			createdAt: true,
			assetChecksum: true,
			verificationGeneration: true,
			attemptNumber: true,
			evidenceKind: true,
			rawEnvelope: true,
		},
	},
} satisfies Prisma.MediaAssetSelect;

type InspectionImage = Prisma.MediaAssetGetPayload<{ select: typeof imageSelect }>;
type ImageStatus =
	| "UPLOADING"
	| "VERIFYING"
	| "VERIFICATION_FAILED"
	| "READY"
	| "QUARANTINED"
	| "DELETED";
export interface AdminImageContentFilter {
	limit: number;
	audience?: "GUEST" | "ACCOUNT";
	status?: ImageStatus;
	kind?: "INPUT" | "OUTPUT";
	search?: string;
	before?: { createdAt: Date; id: string };
}

function object(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function labels(value: unknown): string[] {
	return diagnosticLabels(value);
}

function reviewOf(asset: InspectionImage) {
	const evidence = asset.moderationResults[0];
	if (!evidence) return null;
	const detector = object(object(object(evidence.rawEnvelope).evidence).seeapi);
	const failure = object(object(object(evidence.rawEnvelope).evidence).seeapiFailure);
	return {
		provider: evidence.provider,
		providerTaskId: safeDiagnosticIdentifier(evidence.providerTaskId),
		status: evidence.status,
		reasonCode: safeDiagnosticCode(evidence.reasonCode) ?? "UNKNOWN",
		failureCode: safeDiagnosticCode(failure.code),
		failureStatus: safeDiagnosticText(failure.status, 80),
		createdAt: evidence.createdAt,
		current:
			Boolean(asset.checksum) &&
			evidence.assetChecksum === asset.checksum &&
			evidence.verificationGeneration === asset.verificationGeneration &&
			evidence.attemptNumber === asset.verificationAttemptCount &&
			evidence.evidenceKind === asset.kind &&
			evidence.provider === asset.verificationProvider &&
			evidence.ruleVersion === asset.verificationRuleVersion &&
			evidence.policyVersion === asset.verificationPolicyVersion &&
			evidence.providerTaskId === asset.verificationProviderTaskId,
		flagged: typeof detector.flagged === "boolean" ? detector.flagged : null,
		nsfw: labels(detector.nsfw),
		specialCare: labels(detector.specialCare),
	};
}

export async function listAdminImageContent(
	input: AdminImageContentFilter,
	client: MediaTransactionClient,
	actorUserId?: string,
) {
	const limit = Math.max(1, Math.min(input.limit, 50));
	const rows = await client.mediaAsset.findMany({
		where: {
			mimeType: { startsWith: "image/" },
			...(input.audience
				? {
						retentionClass:
							input.audience === "GUEST" ? ("GUEST_TRIAL" as const) : ("ACCOUNT" as const),
					}
				: {}),
			...(input.kind ? { kind: input.kind } : {}),
			...(input.status ? { status: input.status } : {}),
			AND: [
				...(input.before
					? [
							{
								OR: [
									{ createdAt: { lt: input.before.createdAt } },
									{ createdAt: input.before.createdAt, id: { lt: input.before.id } },
								],
							},
						]
					: []),
				...(input.search
					? [
							{
								OR: [
									{ id: input.search },
									{ ownerId: input.search },
									{ jobBindings: { some: { jobId: input.search } } },
								],
							},
						]
					: []),
			],
		},
		select: imageSelect,
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		take: limit + 1,
	});
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	if (actorUserId)
		await client.auditLog.create({
			data: {
				actorUserId,
				action: "MEDIA_CUSTOMER_CONTENT_LISTED",
				targetType: "ADMIN_MEDIA_CONTENT",
				targetId: "images",
				metadata: {
					audience: input.audience ?? "ALL",
					status: input.status ?? null,
					kind: input.kind ?? null,
					resultCount: page.length,
				},
			},
		});
	return {
		items: page.map((asset) => ({
			id: asset.id,
			ownerType: asset.ownerType,
			ownerId: asset.ownerId,
			audience: asset.retentionClass === "GUEST_TRIAL" ? ("GUEST" as const) : ("ACCOUNT" as const),
			kind: asset.kind,
			status: asset.status,
			createdAt: asset.createdAt,
			provider: asset.moderationResults[0]?.provider ?? asset.verificationProvider,
			reviewStatus: asset.moderationResults[0]?.status ?? null,
			reasonCode: asset.moderationResults[0]?.reasonCode ?? asset.verificationLastErrorCode,
		})),
		nextCursor: rows.length > limit && last ? { createdAt: last.createdAt, id: last.id } : null,
	};
}

function inspectImage(asset: InspectionImage, bindingChecksum?: string, role = asset.kind) {
	let availability: "AVAILABLE" | "DELETED" | "UNFINALIZED" | "UNSUPPORTED" | "CHANGED" =
		"AVAILABLE";
	if (asset.deletedAt || asset.status === "DELETED") availability = "DELETED";
	else if (!asset.mimeType.startsWith("image/")) availability = "UNSUPPORTED";
	else if (!asset.checksum || !asset.finalizedAt) availability = "UNFINALIZED";
	else if (bindingChecksum !== undefined && bindingChecksum !== asset.checksum)
		availability = "CHANGED";
	return {
		id: asset.id,
		kind: asset.kind,
		role,
		status: asset.status,
		createdAt: asset.createdAt,
		availability,
		previewKey: availability === "AVAILABLE" ? asset.objectKey : null,
		review: reviewOf(asset),
	};
}

/** Private administrator inspection, including ordinary content refusals with no recovery review. */
export async function getAdminImageContent(
	input: { assetId: string; jobId?: string },
	actorUserId: string,
	client: MediaTransactionClient,
) {
	const asset = await client.mediaAsset.findFirst({
		where: { id: input.assetId, mimeType: { startsWith: "image/" } },
		select: imageSelect,
	});
	if (!asset) throw new Error("ADMIN_CONTENT_NOT_FOUND");
	const bindings = await client.generationJobAsset.findMany({
		where: { assetId: asset.id },
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		take: 10,
		select: {
			job: {
				select: { id: true, status: true, productKey: true, failureCode: true, createdAt: true },
			},
		},
	});
	const jobs = [...new Map(bindings.map(({ job }) => [job.id, job])).values()];
	const selectedJobId = input.jobId ?? jobs[0]?.id;
	const selectedBinding = selectedJobId
		? await client.generationJobAsset.findFirst({
				where: { jobId: selectedJobId, assetId: asset.id },
				select: {
					assetChecksum: true,
					role: true,
					job: {
						select: {
							id: true,
							status: true,
							productKey: true,
							failureCode: true,
							createdAt: true,
							inputSnapshot: true,
							quoteId: true,
							failureMessage: true,
							attempts: {
								orderBy: { attemptNumber: "desc" },
								take: 10,
								select: {
									id: true,
									provider: true,
									providerTaskId: true,
									status: true,
									uncertainSubmission: true,
									responseSnapshot: true,
									errorSnapshot: true,
									createdAt: true,
								},
							},
							assets: {
								orderBy: [{ role: "asc" }, { position: "asc" }, { id: "asc" }],
								take: 16,
								select: { role: true, assetChecksum: true, asset: { select: imageSelect } },
							},
						},
					},
				},
			})
		: null;
	const job = selectedBinding?.job;
	if (selectedJobId && !job) throw new Error("ADMIN_CONTENT_JOB_NOT_FOUND");
	if (job && !jobs.some(({ id }) => id === job.id)) {
		jobs.unshift({
			id: job.id,
			status: job.status,
			productKey: job.productKey,
			failureCode: job.failureCode,
			createdAt: job.createdAt,
		});
		jobs.splice(10);
	}
	await client.auditLog.create({
		data: {
			actorUserId,
			action: "MEDIA_CUSTOMER_CONTENT_VIEWED",
			targetType: "MEDIA_ASSET",
			targetId: asset.id,
			metadata: { jobId: selectedJobId ?? null },
		},
	});
	const prompt = object(job?.inputSnapshot).prompt;
	const promptAudits = await client.auditLog.findMany({
		where: {
			OR: [
				...(job?.quoteId
					? [
							{
								action: "MEDIA_TEXT_MODERATION_ALLOWED",
								targetType: "GENERATION_QUOTE",
								targetId: job.quoteId,
							},
						]
					: []),
				{
					action: "MEDIA_TEXT_MODERATION_BLOCKED",
					targetType: "GENERATION_QUOTE_REQUEST",
					metadata: { path: ["sourceAssetId"], equals: asset.id },
				},
			],
		},
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		take: 20,
		select: { id: true, after: true, metadata: true, createdAt: true },
	});
	const savedPrompts = await getAssetPromptRecords(asset.id, client);
	const blockedPrompts = promptAudits.flatMap((row): MediaPromptRecord[] => {
		const data = object(row.metadata);
		const blockedPrompt = safeDiagnosticText(data.prompt, 10_000);
		return data.sourceAssetId === asset.id && blockedPrompt && typeof data.productKey === "string"
			? [
					{
						id: row.id,
						prompt: blockedPrompt,
						productKey: data.productKey,
						source: "BLOCKED_REQUEST",
						createdAt: row.createdAt,
						jobId: null,
					},
				]
			: [];
	});
	let cleanup: {
		state: "QUEUED" | "RETRYING" | "FAILED" | "COMPLETED" | "UNKNOWN";
		attempts: number;
	} | null = null;
	if (asset.status === "DELETED") {
		const [completed, pending] = await Promise.all([
			client.auditLog.findFirst({
				where: {
					action: "MEDIA_OBJECT_DELETE_COMPLETED",
					targetType: "MEDIA_STORAGE_OPERATION",
					AND: [
						{ metadata: { path: ["assetId"], equals: asset.id } },
						{ metadata: { path: ["objectKey"], equals: asset.objectKey } },
					],
				},
				select: { id: true },
			}),
			client.outboxEvent.findFirst({
				where: {
					eventType: "MEDIA_OBJECT_DELETE",
					aggregateType: "MEDIA_ASSET",
					aggregateId: asset.id,
					payload: { path: ["objectKey"], equals: asset.objectKey },
				},
				orderBy: { createdAt: "desc" },
				select: { status: true, attempts: true },
			}),
		]);
		cleanup = {
			state: completed
				? "COMPLETED"
				: pending?.status === "DEAD_LETTER"
					? "FAILED"
					: pending?.attempts
						? "RETRYING"
						: pending
							? "QUEUED"
							: "UNKNOWN",
			attempts: pending?.attempts ?? 0,
		};
	}
	return {
		ownerType: asset.ownerType,
		ownerId: asset.ownerId,
		audience: asset.retentionClass === "GUEST_TRIAL" ? ("GUEST" as const) : ("ACCOUNT" as const),
		image: inspectImage(asset, selectedBinding?.assetChecksum, selectedBinding?.role),
		jobs,
		selectedJobId: selectedJobId ?? null,
		prompt:
			typeof prompt === "string" && prompt.length <= 10_000
				? safeDiagnosticText(prompt, 10_000)
				: null,
		promptRecords: [
			...savedPrompts.map((record) => ({
				...record,
				prompt: safeDiagnosticText(record.prompt, 10_000) ?? "",
			})),
			...blockedPrompts,
		]
			.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
			.slice(0, 20),
		promptReviews: promptAudits.map((row) =>
			promptReviewProjection(row.after, row.createdAt, row.id),
		),
		attempts: (job?.attempts ?? []).map(attemptProjection),
		failureMessage: safeDiagnosticText(job?.failureMessage),
		cleanup,
		relatedImages: (job?.assets ?? [])
			.filter((binding) => binding.asset.id !== asset.id)
			.map((binding) => inspectImage(binding.asset, binding.assetChecksum, binding.role)),
	};
}
