import { createHash } from "node:crypto";

import {
	canonicalSourceTemplateJson,
	sourceTemplateReferenceSchema,
	sourceTemplateKeySchema,
} from "@repo/config/video-template-execution.server";
import { z } from "zod";

import type { Prisma } from "../../generated/client";
import { lockMediaAssetGenerationBindings } from "./asset-binding-locks";
import { lockOwnerStorageUsage } from "./storage-usage-locks";
import { runSerializable, type MediaTransactionClient } from "./types";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().min(1).max(2000);
export const sourceMaterialImportTargetSchema = z
	.object({
		environment: z.enum(["local", "staging", "production"]),
		databaseIdentity: text,
		storageEndpoint: z.string().url(),
		bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
	})
	.strict();
export type SourceMaterialImportTarget = z.infer<typeof sourceMaterialImportTargetSchema>;
export const sourceMaterialProvenanceSchema = z
	.object({
		sourceRepository: z.literal("ez-airapvideo"),
		sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
		sourceConfigKey: text,
		sourceRole: text,
		sourceAssetSha256: hash,
		sourceRevision: text,
		sourceUrlSha256: hash.nullable(),
		inspectionReceiptId: text,
		inspector: text,
		inspectionMethod: z.enum(["visual-and-source-hash", "source-hash-and-wav-header"]),
		inspectedAt: z.string().datetime(),
	})
	.strict();

/** Explicit administrator application of a recorded source inspection, not a supplier verdict. */
export const sourceMaterialImportApprovalSchema = z
	.object({
		approvalReceiptId: text,
		approvalKind: z.enum(["administrator-application", "test-fixture"]),
		targetEnvironment: z.enum(["local", "staging", "production"]),
		templateKey: sourceTemplateKeySchema,
		version: text,
		ownerId: z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/),
		sourceUrl: z.string().url(),
		checksum: hash,
		bytes: z
			.number()
			.int()
			.positive()
			.max(25 * 1024 * 1024),
		mimeType: z.enum(["image/jpeg", "image/png", "image/webp", "audio/wav"]),
		decision: z.literal("ALLOW"),
		reviewedAt: z.string().datetime(),
		validUntil: z.string().datetime(),
		rightsEvidence: text,
		ruleVersion: text,
		policyVersion: text,
		sourceProvenance: sourceMaterialProvenanceSchema,
	})
	.strict();
export type SourceMaterialImportApproval = z.infer<typeof sourceMaterialImportApprovalSchema>;
type Reference = z.infer<typeof sourceTemplateReferenceSchema>;
const administratorApprovalSchema = sourceTemplateReferenceSchema
	.extend({
		approvalReceiptId: text,
		approvalKind: z.enum(["administrator-application", "test-fixture"]),
		targetEnvironment: z.enum(["local", "staging", "production"]),
		templateKey: sourceTemplateKeySchema,
		version: text,
		reviewerId: text,
		reviewedAt: z.string().datetime(),
		decision: z.literal("ALLOW"),
		reviewKind: z.enum(["administrator-image", "administrator-audio"]),
		sourceProvenance: sourceMaterialProvenanceSchema,
	})
	.strict();

export function isSourceTemplateAdministratorApproval(
	value: unknown,
	expected: {
		templateKey: string;
		version: string;
		reference: Reference;
		mimeType: string;
		now: Date;
		targetEnvironment?: string;
	},
): boolean {
	const result = administratorApprovalSchema.safeParse(value);
	if (!result.success) return false;
	const approval = result.data;
	const audio = expected.mimeType === "audio/wav";
	return (
		(audio || ["image/jpeg", "image/png", "image/webp"].includes(expected.mimeType)) &&
		(!expected.targetEnvironment || approval.targetEnvironment === expected.targetEnvironment) &&
		(approval.approvalKind !== "test-fixture" ||
			(approval.targetEnvironment === "local" && process.env.NODE_ENV !== "production")) &&
		approval.templateKey === expected.templateKey &&
		approval.version === expected.version &&
		Object.entries(expected.reference).every(
			([key, item]) => approval[key as keyof typeof approval] === item,
		) &&
		approval.reviewerId === expected.reference.ownerId &&
		Date.parse(approval.reviewedAt) <= expected.now.getTime() &&
		Date.parse(approval.sourceProvenance.inspectedAt) <= Date.parse(approval.reviewedAt) &&
		Date.parse(approval.validUntil) > expected.now.getTime() &&
		approval.sourceProvenance.sourceAssetSha256 === expected.reference.checksum &&
		approval.reviewKind === (audio ? "administrator-audio" : "administrator-image") &&
		approval.sourceProvenance.inspectionMethod ===
			(audio ? "source-hash-and-wav-header" : "visual-and-source-hash")
	);
}

function validateApproval(value: unknown, now: Date) {
	const input = sourceMaterialImportApprovalSchema.parse(value);
	if (
		input.sourceProvenance.sourceAssetSha256 !== input.checksum ||
		(input.approvalKind === "test-fixture" &&
			(input.targetEnvironment !== "local" || process.env.NODE_ENV === "production")) ||
		Date.parse(input.sourceProvenance.inspectedAt) > Date.parse(input.reviewedAt) ||
		Date.parse(input.reviewedAt) > now.getTime() ||
		Date.parse(input.validUntil) <= now.getTime() ||
		input.sourceProvenance.inspectionMethod !==
			(input.mimeType === "audio/wav" ? "source-hash-and-wav-header" : "visual-and-source-hash")
	)
		throw new Error("SOURCE_TEMPLATE_APPROVAL_INVALID");
	return input;
}

export function sourceMaterialImportIdentity(value: SourceMaterialImportApproval) {
	const input = sourceMaterialImportApprovalSchema.parse(value);
	const fingerprint = createHash("sha256").update(canonicalSourceTemplateJson(input)).digest("hex");
	const assetId = `source-material-${fingerprint}`;
	return {
		assetId,
		objectKey: `users/${input.ownerId}/source-templates/${fingerprint}`,
		referenceKey: `source-template-material:${assetId}`,
	};
}

async function lockAndClock(tx: Prisma.TransactionClient, ownerId: string, assetId: string) {
	await lockOwnerStorageUsage({ ownerType: "USER", ownerId }, tx);
	await lockMediaAssetGenerationBindings([assetId], tx);
	if (
		!(await tx.user.findFirst({
			where: {
				id: ownerId,
				role: "admin",
				isAnonymous: false,
				OR: [{ banned: false }, { banned: null }],
			},
			select: { id: true },
		}))
	)
		throw new Error("SOURCE_TEMPLATE_ADMIN_OWNER_REQUIRED");
	const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
	if (!clock) throw new Error("DATABASE_CLOCK_UNAVAILABLE");
	return clock.now;
}

/** Reserve before any storage write. Unknown writes retain this same durable identity and quota. */
export function reserveSourceTemplateMaterial(
	value: SourceMaterialImportApproval,
	maximumBytes: bigint,
	client: MediaTransactionClient,
) {
	const identity = sourceMaterialImportIdentity(value);
	if (maximumBytes <= 0n) throw new Error("SOURCE_TEMPLATE_QUOTA_REQUIRED");
	return runSerializable(client, async (tx) => {
		const now = await lockAndClock(tx, value.ownerId, identity.assetId);
		const input = validateApproval(value, now);
		const existing = await tx.mediaAsset.findUnique({ where: { id: identity.assetId } });
		const reservation = await tx.storageUsageReservation.findUnique({
			where: { referenceKey: identity.referenceKey },
		});
		if (existing || reservation) {
			if (
				!existing ||
				!reservation ||
				existing.ownerId !== input.ownerId ||
				existing.ownerType !== "USER" ||
				existing.objectKey !== identity.objectKey ||
				existing.checksum !== input.checksum ||
				existing.byteSize !== BigInt(input.bytes) ||
				existing.mimeType !== input.mimeType ||
				existing.deletedAt ||
				!["UPLOADING", "READY"].includes(existing.status) ||
				reservation.ownerId !== input.ownerId ||
				reservation.ownerType !== "USER" ||
				reservation.bytes !== BigInt(input.bytes) ||
				!["ACTIVE", "COMMITTED"].includes(reservation.status)
			)
				throw new Error("SOURCE_TEMPLATE_IMPORT_IDENTITY_CHANGED");
			return { ...identity, alreadyCommitted: existing.status === "READY" };
		}
		// Explicit operator maximum is an absolute import limit even for paid administrators.
		const usage = await tx.storageUsageReservation.aggregate({
			where: { ownerType: "USER", ownerId: input.ownerId, status: { in: ["ACTIVE", "COMMITTED"] } },
			_sum: { bytes: true },
		});
		if ((usage._sum.bytes ?? 0n) + BigInt(input.bytes) > maximumBytes)
			throw new Error("STORAGE_QUOTA_EXCEEDED");
		await tx.mediaAsset.create({
			data: {
				id: identity.assetId,
				ownerType: "USER",
				ownerId: input.ownerId,
				kind: "INPUT",
				status: "UPLOADING",
				objectKey: identity.objectKey,
				mimeType: input.mimeType,
				byteSize: BigInt(input.bytes),
				checksum: input.checksum,
				sourceUrl: input.sourceUrl,
				verificationEngine: "video-workflow-v1",
			},
		});
		await tx.storageUsageReservation.create({
			data: {
				ownerType: "USER",
				ownerId: input.ownerId,
				bytes: BigInt(input.bytes),
				referenceKey: identity.referenceKey,
				// Import is durable; an interrupted/unknown write must never silently release its bytes.
				expiresAt: new Date("9999-12-31T23:59:59.000Z"),
			},
		});
		return { ...identity, alreadyCommitted: false };
	});
}

/** Identity-verified private storage receipt and administrator evidence commit atomically. */
export function commitSourceTemplateMaterial(
	value: SourceMaterialImportApproval,
	stored: { bytes: number; sha256: string; etag: string; versionId: string | null },
	client: MediaTransactionClient,
) {
	const identity = sourceMaterialImportIdentity(value);
	return runSerializable(client, async (tx) => {
		const now = await lockAndClock(tx, value.ownerId, identity.assetId);
		const input = validateApproval(value, now);
		if (stored.bytes !== input.bytes || stored.sha256 !== input.checksum || !stored.etag)
			throw new Error("SOURCE_TEMPLATE_STORAGE_IDENTITY_MISMATCH");
		const asset = await tx.mediaAsset.findUnique({ where: { id: identity.assetId } });
		const reservation = await tx.storageUsageReservation.findUnique({
			where: { referenceKey: identity.referenceKey },
		});
		if (
			!asset ||
			asset.ownerType !== "USER" ||
			asset.ownerId !== input.ownerId ||
			asset.objectKey !== identity.objectKey ||
			asset.checksum !== input.checksum ||
			asset.byteSize !== BigInt(input.bytes) ||
			asset.mimeType !== input.mimeType ||
			asset.deletedAt ||
			!["UPLOADING", "READY"].includes(asset.status) ||
			!reservation ||
			reservation.ownerType !== "USER" ||
			reservation.ownerId !== input.ownerId ||
			reservation.bytes !== BigInt(input.bytes) ||
			!["ACTIVE", "COMMITTED"].includes(reservation.status)
		)
			throw new Error("SOURCE_TEMPLATE_IMPORT_IDENTITY_CHANGED");
		const reference = sourceTemplateReferenceSchema.parse({
			assetId: identity.assetId,
			objectKey: identity.objectKey,
			ownerId: input.ownerId,
			checksum: input.checksum,
			storageEtag: stored.etag,
			storageVersionId: stored.versionId,
			verificationGeneration: 1,
			sourceUrl: input.sourceUrl,
			rightsEvidence: input.rightsEvidence,
			validUntil: input.validUntil,
		});
		const approval = administratorApprovalSchema.parse({
			...reference,
			approvalReceiptId: input.approvalReceiptId,
			templateKey: input.templateKey,
			version: input.version,
			approvalKind: input.approvalKind,
			targetEnvironment: input.targetEnvironment,
			reviewerId: input.ownerId,
			reviewedAt: input.reviewedAt,
			decision: "ALLOW",
			reviewKind: input.mimeType === "audio/wav" ? "administrator-audio" : "administrator-image",
			sourceProvenance: input.sourceProvenance,
		});
		if (asset.status === "READY") {
			const evidence = await tx.assetModerationResult.findUnique({
				where: {
					assetId_verificationGeneration_attemptNumber: {
						assetId: asset.id,
						verificationGeneration: 1,
						attemptNumber: 1,
					},
				},
			});
			if (
				!asset.finalizedAt ||
				asset.deleteAfter ||
				asset.verificationEngine !== "video-workflow-v1" ||
				asset.verificationGeneration !== 1 ||
				asset.verificationAttemptCount !== 1 ||
				asset.verificationProvider !== "administrator" ||
				asset.verificationProviderTaskId !== null ||
				asset.verificationRuleVersion !== input.ruleVersion ||
				asset.verificationPolicyVersion !== input.policyVersion ||
				asset.verificationValidUntil?.getTime() !== Date.parse(input.validUntil) ||
				asset.storageEtag !== stored.etag ||
				asset.storageVersionId !== stored.versionId ||
				reservation.status !== "COMMITTED" ||
				!evidence ||
				canonicalSourceTemplateJson(evidence.rawEnvelope) !==
					canonicalSourceTemplateJson({ sourceTemplateReferenceApproval: approval })
			)
				throw new Error("SOURCE_TEMPLATE_IMPORT_IDENTITY_CHANGED");
			return {
				templateKey: input.templateKey,
				version: input.version,
				approvalKind: input.approvalKind,
				...reference,
			};
		}
		if (reservation.status !== "ACTIVE") throw new Error("SOURCE_TEMPLATE_IMPORT_IDENTITY_CHANGED");
		await tx.assetModerationResult.create({
			data: {
				assetId: asset.id,
				assetChecksum: input.checksum,
				verificationGeneration: 1,
				attemptNumber: 1,
				evidenceKind: "INPUT",
				provider: "administrator",
				providerTaskId: null,
				ruleVersion: input.ruleVersion,
				policyVersion: input.policyVersion,
				status: "APPROVED",
				reasonCode: "SOURCE_MATERIAL_INSPECTION_ATTESTED",
				categories: [],
				rawEnvelope: { sourceTemplateReferenceApproval: approval },
				validUntil: new Date(input.validUntil),
			},
		});
		await tx.mediaAsset.update({
			where: { id: asset.id },
			data: {
				status: "READY",
				finalizedAt: now,
				storageEtag: stored.etag,
				storageVersionId: stored.versionId,
				verificationGeneration: 1,
				verificationAttemptCount: 1,
				verificationProvider: "administrator",
				verificationProviderTaskId: null,
				verificationRuleVersion: input.ruleVersion,
				verificationPolicyVersion: input.policyVersion,
				verificationValidUntil: new Date(input.validUntil),
			},
		});
		await tx.storageUsageReservation.update({
			where: { id: reservation.id },
			data: { status: "COMMITTED" },
		});
		return {
			templateKey: input.templateKey,
			version: input.version,
			approvalKind: input.approvalKind,
			...reference,
		};
	});
}
