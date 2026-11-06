import assert from "node:assert/strict";
import { test } from "node:test";

import {
	archivedSourceMaterials,
	prepareArchivedSourceTemplateConfig,
} from "../../packages/ai/media/rap-templates/archive";
import { resolveSourceTemplateRequest } from "../../packages/ai/media/rap-templates/contracts";
import manifest from "../../packages/ai/media/rap-templates/source-manifest.json";
import { SOURCE_TEMPLATE_CONTRACT_VERSION } from "../../packages/config/video-template-execution.server";
import {
	SOURCE_TEMPLATE_KEYS,
	sourceTemplateDefaults,
	sourceTemplateRoles,
} from "../../packages/config/video-template-library";
import type { SourceMaterialImportApproval } from "../../packages/database/prisma/queries/media/source-template-material-import";
import {
	assertSourceMaterialImportTarget,
	importSourceTemplateMaterials,
} from "./import-source-template-materials";

const target = {
	environment: "local" as const,
	databaseIdentity: "postgresql://127.0.0.1:55432/fixture",
	storageEndpoint: "http://127.0.0.1:59000/",
	bucket: "source-template-import-test",
};
function approvals(): SourceMaterialImportApproval[] {
	return SOURCE_TEMPLATE_KEYS.flatMap((templateKey) => {
		const defaults = sourceTemplateDefaults(templateKey);
		const choices =
			templateKey === "spin-me-round"
				? (["empty-room", "retro-neon"] as const).map((sceneId) => ({ ...defaults, sceneId }))
				: [defaults];
		const urls = new Set(
			choices.flatMap(
				(options) =>
					resolveSourceTemplateRequest({
						templateKey,
						options,
						userImageUrls: sourceTemplateRoles(templateKey, options).map(
							(role) => `https://ezpic-template.example/fixture/${role}`,
						),
						configs: prepareArchivedSourceTemplateConfig(templateKey),
					}).requiredAssetUrls,
			),
		);
		return [...urls].map((sourceUrl) => {
			const material = archivedSourceMaterials.find((item) => item.transportUrl === sourceUrl)!;
			return {
				approvalReceiptId: `test-fixture:${templateKey}`,
				approvalKind: "test-fixture" as const,
				targetEnvironment: "local" as const,
				templateKey,
				version: SOURCE_TEMPLATE_CONTRACT_VERSION,
				ownerId: "test-admin",
				sourceUrl,
				checksum: material.sha256,
				bytes: material.bytes,
				mimeType: material.mimeType as SourceMaterialImportApproval["mimeType"],
				decision: "ALLOW" as const,
				reviewedAt: "2026-11-06T08:00:00.000Z",
				validUntil: "2026-11-07T08:00:00.000Z",
				rightsEvidence: "Synthetic local test evidence only",
				ruleVersion: "source-material-import-v1",
				policyVersion: "source-material-import-v1",
				sourceProvenance: {
					sourceRepository: "ez-airapvideo" as const,
					sourceCommit: manifest.sourceCommit,
					sourceConfigKey: material.sourceConfigKey,
					sourceRole: material.role,
					sourceAssetSha256: material.sha256,
					sourceRevision: material.revision,
					sourceUrlSha256: material.sourceUrlSha256,
					inspectionReceiptId: "synthetic-fixture",
					inspector: "unit-test",
					inspectedAt: "2026-11-06T07:00:00.000Z",
					inspectionMethod:
						material.mimeType === "audio/wav"
							? ("source-hash-and-wav-header" as const)
							: ("visual-and-source-hash" as const),
				},
			};
		});
	});
}
void test("offline dry-run verifies all original assets including both Spin scenes and four Flying variants", async () => {
	const result = await importSourceTemplateMaterials({
		root: process.cwd(),
		target,
		approvals: approvals(),
		maximumBytes: 100_000_000n,
		apply: false,
	});
	assert.equal(result.status, "DRY_RUN");
	assert.equal(result.materials, 45);
	assert.equal(result.databaseWritten, false);
	assert.deepEqual(result.references, []);
	assert.equal(result.generationInvoked, false);
});
void test("rejects mismatched archive provenance and cross-template material before connecting", async () => {
	const input = approvals()[0]!;
	await assert.rejects(
		importSourceTemplateMaterials({
			root: process.cwd(),
			target,
			approvals: [{ ...input, bytes: input.bytes + 1 }],
			maximumBytes: 100_000_000n,
			apply: false,
		}),
		/ARCHIVE_BINDING_MISMATCH/,
	);
	await assert.rejects(
		importSourceTemplateMaterials({
			root: process.cwd(),
			target,
			approvals: [{ ...input, templateKey: "original-rap" }],
			maximumBytes: 100_000_000n,
			apply: false,
		}),
		/ARCHIVE_ROLE_MISMATCH/,
	);
});
void test("requires explicit matching database and storage targets; rejects production fixtures", async () => {
	assert.doesNotThrow(() =>
		assertSourceMaterialImportTarget(target, {
			DATABASE_URL: "postgresql://fixture:secret@127.0.0.1:55432/fixture",
			S3_ENDPOINT: target.storageEndpoint,
			MEDIA_BUCKET_NAME: target.bucket,
		}),
	);
	assert.throws(
		() =>
			assertSourceMaterialImportTarget(target, {
				DATABASE_URL: "postgresql://fixture:secret@remote.invalid/fixture",
				S3_ENDPOINT: target.storageEndpoint,
				MEDIA_BUCKET_NAME: target.bucket,
			}),
		/TARGET_MISMATCH/,
	);
	await assert.rejects(
		importSourceTemplateMaterials({
			root: process.cwd(),
			target: { ...target, environment: "production" },
			approvals: approvals(),
			maximumBytes: 100_000_000n,
			apply: false,
		}),
		/TARGET_MISMATCH/,
	);
});
