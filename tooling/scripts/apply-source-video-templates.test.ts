import assert from "node:assert/strict";
import { before, test } from "node:test";

import {
	sourceTemplateSnapshotSchema,
	SOURCE_TEMPLATE_CONTRACT_VERSION,
	decodeSourceTemplatePrice,
} from "../../packages/config/video-template-execution.server";
import type { MediaTransactionClient } from "../../packages/database/prisma/queries/media/types";
import type { applySourceTemplateProvisionBundle } from "../../packages/database/prisma/queries/media/video-source-template-admission";
import {
	applySourceVideoTemplates,
	validateSourceVideoTemplateBundle,
} from "./apply-source-video-templates";
import {
	prepareSourceVideoTemplates,
	sourceTemplateBundleHash,
	type PreparedSourceVideoTemplates,
	type SourceTemplateImportReceipt,
} from "./prepare-source-video-templates";

const now = new Date("2026-11-06T08:00:00.000Z");
const target = {
	environment: "local" as const,
	databaseIdentity: "postgresql://localhost:55432/template_test",
	storageEndpoint: "http://localhost:59000/",
	bucket: "template-test",
};
const environment = {
	DATABASE_URL: "postgresql://fixture:fixture@localhost:55432/template_test",
	S3_ENDPOINT: target.storageEndpoint,
	MEDIA_BUCKET_NAME: target.bucket,
	VIDEO_V1_VIDEO_SAFETY_ADAPTER: "seeapi",
	VIDEO_V1_TEXT_SAFETY_ADAPTER: "waffo",
	VIDEO_COST_VISUAL_POLICY_VERSION: "seeapi-video-policy-2026-10-04.1",
	VIDEO_COST_TEXT_RULE_VERSION: "waffo-prompt-safety-2026-10-04.1",
	SOURCE_TEMPLATE_TEXT_REVIEW_COST_MICROS: "100",
	SOURCE_TEMPLATE_TEXT_COST_BASIS: "test-only fixture",
	VIDEO_COST_RUNTIME_MICROS: "1000",
	VIDEO_COST_STORAGE_MICROS: "1000",
	VIDEO_COST_PAYMENT_FIXED_MICROS: "1000",
	VIDEO_COST_PAYMENT_FEE_BPS: "500",
	VIDEO_COST_NONBILLABLE_FAILURE_BPS: "500",
};
let bundle: PreparedSourceVideoTemplates;
const fakeDatabase = {} as MediaTransactionClient;
const calls: Parameters<typeof applySourceTemplateProvisionBundle>[0][] = [];
const fakeApply: typeof applySourceTemplateProvisionBundle = async (input) => {
	calls.push(input);
	return {
		dryRun: Boolean(input.dryRun),
		replayed: false,
		records: input.records.map((item, index) => ({
			configKey: item.configKey,
			id: `override-${index}`,
			version: index + 1,
			replayed: false,
		})),
	};
};
before(async () => {
	const prepared = await prepareSourceVideoTemplates(process.cwd(), { now, environment });
	const receipt: SourceTemplateImportReceipt = {
		schemaVersion: 1,
		target,
		references: prepared.records.flatMap((item) =>
			item.requiredMaterialHashes.map((checksum) => {
				const material = prepared.materials.find((asset) => asset.sha256 === checksum)!;
				return {
					templateKey: item.templateKey,
					version: SOURCE_TEMPLATE_CONTRACT_VERSION,
					approvalKind: "test-fixture" as const,
					assetId: `fixture-${item.templateKey}-${checksum}`,
					checksum,
					objectKey: `users/admin/fixture/${item.templateKey}/${checksum}`,
					storageEtag: checksum,
					storageVersionId: null,
					verificationGeneration: 1,
					sourceUrl: material.transportUrl,
					ownerId: "fixture-admin",
					rightsEvidence: "fixture only",
					validUntil: "2026-11-07T08:00:00.000Z",
				};
			}),
		),
	};
	bundle = await prepareSourceVideoTemplates(process.cwd(), { now, environment, receipt });
	assert.equal(bundle.status, "READY_TO_APPLY");
});
const input = () => ({
	root: process.cwd(),
	target,
	environment,
	bundle,
	now,
	administratorId: "fixture-admin",
	apply: false,
});

void test("validates every price and reference before handing one complete atomic bundle to the DB helper", async () => {
	const result = await applySourceVideoTemplates(input(), {
		database: fakeDatabase,
		applyBundle: fakeApply,
	});
	assert.equal(result.status, "VALIDATED");
	assert.equal(result.databaseWritten, false);
	assert.equal(result.generationInvoked, false);
	const call = calls.at(-1)!;
	assert.equal(call.dryRun, true);
	assert.equal(call.records.length, 16);
	assert.deepEqual(call.target, target);
	for (const item of call.records) sourceTemplateSnapshotSchema.parse(item.validationSnapshot);
	const spin = call.records.find((item) => item.configKey.includes("spin-me-round"))!;
	assert.equal(sourceTemplateSnapshotSchema.parse(spin.validationSnapshot).references.length, 2);
});

void test("accepts an intact historical full-evidence bundle through lossless encoding only", async () => {
	const historical = structuredClone(bundle);
	for (const record of historical.records) {
		const value = record.value;
		value.prices = value.prices.map((price) => decodeSourceTemplatePrice(value, price));
		delete value.pricingBasisDictionary;
		delete value.pricingSchemaVersion;
	}
	historical.bundleHash = sourceTemplateBundleHash(historical);
	assert.notEqual(historical.bundleHash, bundle.bundleHash);
	const validated = await validateSourceVideoTemplateBundle({ ...input(), bundle: historical });
	assert.equal(validated.prepared.bundleHash, bundle.bundleHash);
	assert.ok(
		validated.records.some(
			(record) => (record.value as { pricingSchemaVersion?: number }).pricingSchemaVersion === 2,
		),
	);
	// The reviewed input remains full-evidence and its audit hash remains untouched.
	assert.ok(historical.records.every((record) => record.value.pricingSchemaVersion === undefined));
	assert.equal(historical.bundleHash, sourceTemplateBundleHash(historical));
	const changed = structuredClone(historical);
	const first = changed.records[0]!.value.prices[0]!;
	if (!("pricingBasis" in first)) throw new Error("fixture must remain legacy");
	first.pricingBasis += " ";
	changed.bundleHash = sourceTemplateBundleHash(changed);
	await assert.rejects(
		validateSourceVideoTemplateBundle({ ...input(), bundle: changed }),
		/SOURCE_TEMPLATE_BUNDLE_CONTENT_CHANGED/,
	);
});

void test("passes apply intent explicitly and reports a same-bundle DB replay as unchanged", async () => {
	const applied = await applySourceVideoTemplates(
		{ ...input(), apply: true },
		{ database: fakeDatabase, applyBundle: fakeApply },
	);
	assert.equal(applied.status, "APPLIED");
	assert.equal(applied.databaseWritten, true);
	assert.equal(calls.at(-1)!.dryRun, false);
	const replayed = await applySourceVideoTemplates(
		{ ...input(), apply: true },
		{
			database: fakeDatabase,
			applyBundle: async (...args) => ({ ...(await fakeApply(...args)), replayed: true }),
		},
	);
	assert.equal(replayed.status, "UNCHANGED");
	assert.equal(replayed.databaseWritten, false);
});

void test("rejects target mismatch and missing administrator before any DB application", async () => {
	const count = calls.length;
	await assert.rejects(
		applySourceVideoTemplates(
			{ ...input(), target: { ...target, bucket: "different-bucket" } },
			{ database: fakeDatabase, applyBundle: fakeApply },
		),
		/SOURCE_TEMPLATE_TARGET_MISMATCH/,
	);
	await assert.rejects(
		applySourceVideoTemplates(
			{ ...input(), administratorId: "" },
			{ database: fakeDatabase, applyBundle: fakeApply },
		),
		/SOURCE_TEMPLATE_ADMINISTRATOR_REQUIRED/,
	);
	assert.equal(calls.length, count);
});

void test("rejects modified prices/config even when someone recalculates a bundle hash", async () => {
	const altered = structuredClone(bundle);
	altered.records[0]!.value.prices[0]!.credits = "1";
	await assert.rejects(
		validateSourceVideoTemplateBundle({ ...input(), bundle: altered }),
		/SOURCE_TEMPLATE_BUNDLE_HASH_MISMATCH/,
	);
	altered.bundleHash = sourceTemplateBundleHash(altered);
	await assert.rejects(
		validateSourceVideoTemplateBundle({ ...input(), bundle: altered }),
		/SOURCE_TEMPLATE_BUNDLE_CONTENT_CHANGED/,
	);
});

void test("rejects expired approval and pricing-policy drift before the DB application", async () => {
	await assert.rejects(
		validateSourceVideoTemplateBundle({ ...input(), now: new Date("2026-11-08T08:00:00.000Z") }),
		/SOURCE_TEMPLATE_BUNDLE_NOT_READY/,
	);
	await assert.rejects(
		validateSourceVideoTemplateBundle({
			...input(),
			pricingEnvironment: { ...environment, VIDEO_COST_RUNTIME_MICROS: "990000" },
		}),
		/SOURCE_TEMPLATE_BUNDLE_CONTENT_CHANGED/,
	);
});

void test("does not convert DB moderation/rights/admin validation failure into successful publication", async () => {
	await assert.rejects(
		applySourceVideoTemplates(
			{ ...input(), apply: true },
			{
				database: fakeDatabase,
				applyBundle: async () => {
					throw new Error("VIDEO_SOURCE_TEMPLATE_REFERENCE_APPROVAL_REQUIRED");
				},
			},
		),
		/VIDEO_SOURCE_TEMPLATE_REFERENCE_APPROVAL_REQUIRED/,
	);
});
