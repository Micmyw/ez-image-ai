import assert from "node:assert/strict";
import { test } from "node:test";

import { archivedSourceMaterials } from "../../packages/ai/media/rap-templates/archive";
import { resolveSourceTemplatePrice } from "../../packages/config/source-template-pricing.server";
import {
	SOURCE_TEMPLATE_CONTRACT_VERSION,
	canonicalSourceTemplateJson,
	decodeSourceTemplatePrice,
} from "../../packages/config/video-template-execution.server";
import {
	SOURCE_TEMPLATE_KEYS,
	sourceTemplateDefaults,
} from "../../packages/config/video-template-library";
import {
	enumerateSourceTemplatePriceOptions,
	parseSourceTemplateImportReceipt,
	prepareSourceVideoTemplates,
	resolvePreparedSourceRequest,
	type SourceTemplateImportReceipt,
} from "./prepare-source-video-templates";

const now = new Date("2026-11-06T08:00:00.000Z");
const environment = {
	VIDEO_V1_VIDEO_SAFETY_ADAPTER: "seeapi",
	VIDEO_V1_TEXT_SAFETY_ADAPTER: "waffo",
	VIDEO_COST_VISUAL_POLICY_VERSION: "seeapi-video-policy-2026-10-04.1",
	VIDEO_COST_TEXT_RULE_VERSION: "waffo-prompt-safety-2026-10-04.1",
	SOURCE_TEMPLATE_TEXT_REVIEW_COST_MICROS: "100",
	SOURCE_TEMPLATE_TEXT_COST_BASIS: "unit test cost fixture only",
	VIDEO_COST_RUNTIME_MICROS: "1000",
	VIDEO_COST_STORAGE_MICROS: "1000",
	VIDEO_COST_PAYMENT_FIXED_MICROS: "1000",
	VIDEO_COST_PAYMENT_FEE_BPS: "500",
	VIDEO_COST_NONBILLABLE_FAILURE_BPS: "500",
};
function receipt(): SourceTemplateImportReceipt {
	return {
		schemaVersion: 1,
		target: {
			environment: "local",
			databaseIdentity: "postgresql://localhost:55432/template_test",
			storageEndpoint: "http://localhost:59000/",
			bucket: "template-test",
		},
		references: SOURCE_TEMPLATE_KEYS.flatMap((templateKey) => {
			const options = sourceTemplateDefaults(templateKey);
			const variants =
				templateKey === "spin-me-round"
					? [options, { ...options, sceneId: "retro-neon" as const }]
					: [options];
			return [
				...new Set(
					variants.flatMap(
						(choices) => resolvePreparedSourceRequest(templateKey, choices).requiredAssetUrls,
					),
				),
			].map((sourceUrl) => {
				const material = archivedSourceMaterials.find((item) => item.transportUrl === sourceUrl)!;
				return {
					templateKey,
					version: SOURCE_TEMPLATE_CONTRACT_VERSION,
					approvalKind: "test-fixture" as const,
					assetId: `fixture-${templateKey}-${material.sha256}`,
					checksum: material.sha256,
					objectKey: `users/admin/fixture/${templateKey}/${material.sha256}`,
					storageEtag: material.sha256,
					storageVersionId: null,
					verificationGeneration: 1,
					sourceUrl,
					ownerId: "fixture-admin",
					rightsEvidence: "unit test fixture; no actual approval",
					validUntil: "2026-11-07T08:00:00.000Z",
				};
			});
		}),
	};
}
const ready = prepareSourceVideoTemplates(process.cwd(), { receipt: receipt(), environment, now });

void test("all 2342 compact prices expand to the exact existing complete price and evidence", async () => {
	const prepared = await ready;
	let count = 0;
	for (const record of prepared.records) {
		const options = enumerateSourceTemplatePriceOptions(record.templateKey);
		for (const [index, choices] of options.entries()) {
			const full = resolveSourceTemplatePrice(
				{
					templateKey: record.templateKey,
					options: choices,
					transport: resolvePreparedSourceRequest(record.templateKey, choices),
				},
				environment,
			);
			assert.deepEqual(decodeSourceTemplatePrice(record.value, record.value.prices[index]!), full);
			count++;
		}
	}
	assert.equal(count, 2342);
	const rap = prepared.records.find((record) => record.templateKey === "original-rap")!.value;
	assert.equal(rap.pricingSchemaVersion, 2);
	assert.equal(rap.pricingBasisDictionary!.overrides.length, 150);
	assert.ok(rap.prices.every((price) => "pricingBasisRef" in price && !("pricingBasis" in price)));
});

void test("prepares 16 source templates and 38 hashes without inventing missing approval or costs", async () => {
	const prepared = await prepareSourceVideoTemplates(process.cwd(), { now });
	assert.equal(prepared.records.length, 16);
	assert.equal(prepared.materials.length, 38);
	assert.equal(prepared.status, "BLOCKED");
	assert.equal(prepared.generationInvoked, false);
	assert.equal(prepared.databaseWritten, false);
	for (const item of prepared.records) {
		assert.equal(item.value.enabled, false);
		assert.equal(item.value.access, "internal");
		assert.deepEqual(item.value.references, []);
		assert.deepEqual(item.value.prices, []);
		assert.ok(item.blockers.includes("TARGET_REQUIRED"));
		for (const hash of item.requiredMaterialHashes)
			assert.ok(prepared.materials.some((material) => material.sha256 === hash));
	}
});

void test("covers dependent public price tuples exactly once and keeps scene/style outside price identity", async () => {
	const prepared = await ready;
	assert.equal(prepared.status, "READY_TO_APPLY");
	for (const item of prepared.records) {
		assert.deepEqual(item.blockers, []);
		assert.equal(item.value.enabled, true);
		assert.equal(item.value.access, "authenticated");
		assert.equal(
			item.value.prices.length,
			enumerateSourceTemplatePriceOptions(item.templateKey).length,
		);
		assert.equal(item.priceTupleCount, item.value.prices.length);
		assert.equal(
			new Set(item.value.prices.map((price) => canonicalSourceTemplateJson(price.options))).size,
			item.value.prices.length,
		);
		assert.ok(
			item.value.prices.every(
				(price) =>
					!("sceneId" in price.options) &&
					!("stageId" in price.options) &&
					BigInt(price.credits) > 0n,
			),
		);
	}
	const rap = prepared.records.find((item) => item.templateKey === "original-rap")!;
	assert.equal(rap.value.prices.length, 390);
	assert.equal(rap.value.prices.filter((price) => price.options.preset === "text").length, 150);
	assert.ok(
		rap.value.prices
			.filter((price) => price.options.tier === "ultra" && price.options.preset !== "text")
			.every((price) => price.options.aspectRatio === "adaptive"),
	);
	const spin = prepared.records.find((item) => item.templateKey === "spin-me-round")!;
	assert.equal(spin.value.prices.length, 360);
	assert.equal(spin.value.references.length, 2, "both scene images must be bound");
	assert.ok(spin.value.prices.some((price) => price.options.preset === "trio"));
});

void test("provider-owned Hotel null prompt/duration is valid with 14 native prices and no invented references", async () => {
	const hotel = (await ready).records.find((item) => item.templateKey === "source-hotel-lobby")!;
	assert.equal(hotel.sourceContract.output.durationSeconds, null);
	assert.equal(hotel.value.enabled, true);
	assert.equal(hotel.value.prices.length, 14);
	assert.deepEqual(hotel.value.references, []);
	assert.ok(hotel.value.prices.every((price) => price.options.durationSeconds === undefined));
});

void test("reports exact missing and expired reference hashes instead of manufacturing approval", async () => {
	const input = receipt();
	const missing = input.references.find((item) => item.templateKey === "spin-me-round")!;
	input.references = input.references.filter((item) => item !== missing);
	const expired = input.references.find((item) => item.templateKey === "bulin-47")!;
	expired.validUntil = now.toISOString();
	const prepared = await prepareSourceVideoTemplates(process.cwd(), {
		receipt: input,
		environment,
		now,
	});
	assert.equal(prepared.status, "BLOCKED");
	assert.ok(
		prepared.records
			.find((item) => item.templateKey === "spin-me-round")!
			.blockers.includes(`TARGET_REFERENCE_REQUIRED:${missing.checksum}`),
	);
	assert.ok(
		prepared.records
			.find((item) => item.templateKey === "bulin-47")!
			.blockers.includes(`TARGET_REFERENCE_EXPIRED:${expired.checksum}`),
	);
	assert.equal(
		prepared.records.find((item) => item.templateKey === "source-hotel-lobby")!.value.enabled,
		true,
	);
});

void test("rejects duplicate/mismatched receipts and fixture approvals for production", async () => {
	const duplicate = receipt();
	duplicate.references.push(duplicate.references[0]!);
	assert.throws(
		() => parseSourceTemplateImportReceipt(duplicate),
		/SOURCE_TEMPLATE_DUPLICATE_REFERENCE_RECEIPT/,
	);
	const production = receipt();
	production.target.environment = "production";
	assert.throws(
		() => parseSourceTemplateImportReceipt(production),
		/SOURCE_TEMPLATE_FIXTURE_TARGET_FORBIDDEN/,
	);
	const changed = receipt();
	changed.references[0]!.checksum = "f".repeat(64);
	await assert.rejects(
		prepareSourceVideoTemplates(process.cwd(), { receipt: changed, environment, now }),
		/SOURCE_TEMPLATE_REFERENCE_HASH_MISMATCH/,
	);
});

void test("bundle hash is deterministic and missing target costs are concrete blockers", async () => {
	const first = await ready;
	const second = await prepareSourceVideoTemplates(process.cwd(), {
		receipt: receipt(),
		environment,
		now,
	});
	assert.equal(first.bundleHash, second.bundleHash);
	const incomplete = { ...environment, VIDEO_COST_RUNTIME_MICROS: undefined };
	const blocked = await prepareSourceVideoTemplates(process.cwd(), {
		receipt: receipt(),
		environment: incomplete,
		now,
	});
	assert.ok(
		blocked.records.every(
			(item) =>
				item.blockers.includes("SOURCE_TEMPLATE_PRICE_CONFIG_REQUIRED:VIDEO_COST_RUNTIME_MICROS") &&
				!item.value.enabled,
		),
	);
});
