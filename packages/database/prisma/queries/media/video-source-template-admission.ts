import {
	canonicalSourceTemplateJson,
	sourceTemplateSnapshotSchema,
	sourceTemplateConfigKey,
	sourceTemplateKeySchema,
	sourceTemplateProvisionSchema,
	type SourceTemplateInternalRequest,
} from "@repo/config/video-template-execution.server";

import type { Prisma } from "../../generated/client";
import { lockMediaAssetGenerationBindings } from "./asset-binding-locks";
import { hasCurrentApprovedMediaAssetEvidence } from "./assets";
import { createRuntimeConfigOverride } from "./operations";
import {
	sourceMaterialImportTargetSchema,
	type SourceMaterialImportTarget,
} from "./source-template-material-import";
import { runReadCommitted, type MediaDatabaseClient, type MediaTransactionClient } from "./types";
import { findApprovedSourceTemplateReferences } from "./video-source-template-review";

export async function findSourceTemplateRoleInputs(
	ownerId: string,
	request: SourceTemplateInternalRequest,
	maximumInputBytes: number,
	tx: MediaDatabaseClient,
	now: Date,
) {
	const assets = [];
	for (const input of request.sourceTemplate.request.inputs) {
		const asset = await tx.mediaAsset.findFirst({
			where: {
				id: input.assetId,
				ownerType: "USER",
				ownerId,
				kind: { in: ["INPUT", "OUTPUT"] },
				deletedAt: null,
				finalizedAt: { not: null },
				status: { in: ["VERIFYING", "READY"] },
				OR: [{ deleteAfter: null }, { deleteAfter: { gt: now } }],
			},
			include: {
				moderationResults: {
					orderBy: [{ verificationGeneration: "desc" }, { attemptNumber: "desc" }],
					take: 1,
				},
			},
		});
		if (
			!asset ||
			!asset.checksum ||
			!/^[a-f0-9]{64}$/.test(asset.checksum) ||
			!asset.storageEtag ||
			!["image/png", "image/jpeg"].includes(asset.mimeType) ||
			!asset.width ||
			!asset.height ||
			asset.byteSize <= 0n ||
			asset.byteSize > BigInt(Math.min(maximumInputBytes, 10000000)) ||
			(asset.verificationEngine !== "video-workflow-v1" && asset.status !== "READY")
		)
			throw new Error("VIDEO_INPUT_NOT_AVAILABLE");
		if (
			asset.kind === "OUTPUT" &&
			!hasCurrentApprovedMediaAssetEvidence(asset, {
				verificationEngine: "legacy",
				provider: "seeapi",
				ruleVersion: asset.verificationRuleVersion ?? "",
				policyVersion: asset.verificationPolicyVersion ?? "",
				now,
			})
		)
			throw new Error("VIDEO_INPUT_NOT_AVAILABLE");
		assets.push(asset);
	}
	return assets;
}

/** Only identities observed inside the admission transaction enter the frozen quote. */
export async function sourceTemplateAdmissionData(
	ownerId: string,
	request: SourceTemplateInternalRequest,
	maximumInputBytes: number,
	tx: MediaDatabaseClient,
	now: Date,
) {
	await assertSourceTemplateProvisionCurrent(request, tx);
	const assets = await findSourceTemplateRoleInputs(ownerId, request, maximumInputBytes, tx, now);
	// The published built-in pack is frozen in the request; only customer inputs are mutable here.
	return {
		roleInputIdentities: assets.map((asset, i) => ({
			role: request.sourceTemplate.request.inputs[i]!.role,
			assetId: asset.id,
			checksum: asset.checksum!,
			objectKey: asset.objectKey,
			storageEtag: asset.storageEtag!,
			storageVersionId: asset.storageVersionId,
			verificationGeneration: asset.verificationGeneration,
		})),
	};
}

export async function assertSourceTemplateProvisionCurrent(
	request: SourceTemplateInternalRequest,
	tx: MediaDatabaseClient,
) {
	const record = await tx.runtimeConfigOverride.findFirst({
		where: { configKey: sourceTemplateConfigKey(request.sourceTemplate.templateKey), active: true },
		orderBy: { version: "desc" },
	});
	const provision = sourceTemplateProvisionSchema.safeParse(record?.value);
	if (
		!record ||
		record.id !== request.sourceTemplate.provision.id ||
		record.version !== request.sourceTemplate.provision.version ||
		!provision.success ||
		!provision.data.enabled ||
		provision.data.version !== request.sourceTemplate.version
	)
		throw new Error("VIDEO_TEMPLATE_VERSION_CHANGED");
}

/** Explicit administrator import only. Importing never opens generation or invents approval. */
export async function importDisabledSourceTemplateProvision(
	input: {
		templateKey: SourceTemplateInternalRequest["sourceTemplate"]["templateKey"];
		value: unknown;
		actorUserId: string;
		reason: string;
	},
	client: MediaTransactionClient,
) {
	const provision = sourceTemplateProvisionSchema.parse(input.value);
	const templateKey = sourceTemplateKeySchema.parse(input.templateKey);
	if (provision.enabled || !input.reason.trim())
		throw new Error("VIDEO_TEMPLATE_IMPORT_MUST_BE_DISABLED");
	const admin = await client.user.findFirst({
		where: { id: input.actorUserId, role: "admin" },
		select: { id: true },
	});
	if (!admin) throw new Error("VIDEO_ACCESS_DENIED");
	return createRuntimeConfigOverride(
		{
			configKey: sourceTemplateConfigKey(templateKey),
			value: provision,
			createdByUserId: admin.id,
			reason: input.reason,
		},
		client,
	);
}

/** One audited, idempotent configuration application; never submits generation or writes media. */
export async function applySourceTemplateProvisionBundle(
	input: {
		records: Array<{
			configKey: string;
			value: unknown;
			validationSnapshot: unknown;
			expectedVersion?: number | null;
		}>;
		bundleHash: string;
		administratorId: string;
		reason: string;
		target: SourceMaterialImportTarget;
		dryRun?: boolean;
	},
	client: MediaTransactionClient,
) {
	if (
		!/^[a-f0-9]{64}$/.test(input.bundleHash) ||
		!input.reason.trim() ||
		input.records.length < 1 ||
		input.records.length > sourceTemplateKeySchema.options.length
	)
		throw new Error("VIDEO_TEMPLATE_PROVISION_BUNDLE_INVALID");
	const target = sourceMaterialImportTargetSchema.parse(input.target);
	const records = input.records
		.map((record) => {
			const value = sourceTemplateProvisionSchema.parse(record.value);
			const snapshot = sourceTemplateSnapshotSchema.parse(record.validationSnapshot);
			if (
				record.configKey !== sourceTemplateConfigKey(snapshot.templateKey) ||
				value.version !== snapshot.version ||
				canonicalSourceTemplateJson(value.references) !==
					canonicalSourceTemplateJson(snapshot.references) ||
				(value.enabled && value.prices.length === 0) ||
				(record.expectedVersion !== undefined &&
					record.expectedVersion !== null &&
					(!Number.isSafeInteger(record.expectedVersion) || record.expectedVersion < 1))
			)
				throw new Error("VIDEO_TEMPLATE_PROVISION_BUNDLE_INVALID");
			return { ...record, value, snapshot };
		})
		.sort((left, right) => left.configKey.localeCompare(right.configKey));
	if (new Set(records.map((record) => record.configKey)).size !== records.length)
		throw new Error("VIDEO_TEMPLATE_PROVISION_BUNDLE_INVALID");
	return runReadCommitted(client, async (tx) => {
		// Same global version lock as the existing audited single-config writer.
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('runtime_config_override_version'))`;
		const administrator = await tx.user.findFirst({
			where: { id: input.administratorId, role: "admin" },
			select: { id: true },
		});
		if (!administrator) throw new Error("VIDEO_ACCESS_DENIED");
		await lockMediaAssetGenerationBindings(
			records.flatMap((record) => record.value.references.map((reference) => reference.assetId)),
			tx,
		);
		const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
		if (!clock || !Number.isFinite(clock.now.getTime()))
			throw new Error("DATABASE_CLOCK_UNAVAILABLE");
		const planned = [];
		for (const record of records) {
			await findApprovedSourceTemplateReferences(
				record.snapshot,
				tx,
				clock.now,
				target.environment,
			);
			// Existing revert operations update rows directly, so retain their row
			// locks alongside the shared creation/version lock before replay or CAS.
			await tx.$queryRaw`SELECT "id" FROM "runtime_config_override" WHERE "configKey" = ${record.configKey} AND "active" = true ORDER BY "version" DESC FOR UPDATE`;
			const current = await tx.runtimeConfigOverride.findFirst({
				where: { configKey: record.configKey, active: true },
				orderBy: { version: "desc" },
			});
			const replayed = Boolean(
				current &&
				canonicalSourceTemplateJson(current.value) === canonicalSourceTemplateJson(record.value),
			);
			if (
				!replayed &&
				record.expectedVersion !== undefined &&
				record.expectedVersion !== (current?.version ?? null)
			)
				throw new Error("VIDEO_TEMPLATE_VERSION_CHANGED");
			planned.push({ ...record, current, replayed });
		}
		if (input.dryRun)
			return {
				dryRun: true,
				replayed: planned.every((record) => record.replayed),
				records: planned.map((record) => ({
					configKey: record.configKey,
					id: record.current?.id ?? null,
					version: record.current?.version ?? null,
					replayed: record.replayed,
				})),
			};
		const [latest] = await tx.$queryRaw<
			Array<{ nextVersion: number }>
		>`SELECT COALESCE(MAX("version"), 0) + 1 AS "nextVersion" FROM "runtime_config_override"`;
		if (!latest || !Number.isSafeInteger(latest.nextVersion))
			throw new Error("VIDEO_TEMPLATE_PROVISION_VERSION_INVALID");
		let version = latest.nextVersion;
		const applied = [];
		for (const record of planned) {
			if (record.replayed && record.current) {
				applied.push({
					configKey: record.configKey,
					id: record.current.id,
					version: record.current.version,
					replayed: true,
				});
				continue;
			}
			const created = await tx.runtimeConfigOverride.create({
				data: {
					configKey: record.configKey,
					value: record.value as Prisma.InputJsonValue,
					version: version++,
					reason: input.reason,
					createdByUserId: administrator.id,
				},
			});
			await tx.auditLog.create({
				data: {
					actorUserId: administrator.id,
					action: "RUNTIME_CONFIG_OVERRIDE_CREATED",
					targetType: "RUNTIME_CONFIG_OVERRIDE",
					targetId: created.id,
					after: { configKey: created.configKey, version: created.version },
					metadata: {
						sourceTemplateProvisionBundleHash: input.bundleHash,
						target,
						previousActiveId: record.current?.id ?? null,
					},
				},
			});
			applied.push({
				configKey: created.configKey,
				id: created.id,
				version: created.version,
				replayed: false,
			});
		}
		return {
			dryRun: false,
			replayed: applied.every((record) => record.replayed),
			records: applied,
		};
	});
}

export function getSourceTemplateInputRecord(
	ownerId: string,
	assetId: string,
	tx: MediaDatabaseClient,
) {
	return tx.mediaAsset.findFirst({
		where: {
			id: assetId,
			ownerType: "USER",
			ownerId,
			kind: { in: ["INPUT", "OUTPUT"] },
			mimeType: { in: ["image/jpeg", "image/png"] },
			deletedAt: null,
			finalizedAt: { not: null },
			storageEtag: { not: null },
			checksum: { not: null },
			width: { gt: 0 },
			height: { gt: 0 },
			byteSize: { gt: 0n, lte: 10000000n },
			status: { in: ["VERIFYING", "READY"] },
			OR: [{ deleteAfter: null }, { deleteAfter: { gt: new Date() } }],
		},
	});
}
