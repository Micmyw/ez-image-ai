import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

import { VIDEO_MODEL_CATALOG_VERSION } from "../../../../packages/config/video-models";
import {
	calculateVideoRetailPrice,
	VIDEO_SUPPLIER_PRICE_VERSION,
	videoPaidCreditFloorMicros,
	videoSupplierCostMicros,
	type VideoCostPolicy,
	type VideoPricingSelection,
} from "../../../../packages/config/video-pricing.server";

// Offline conditional reference only. No runtime environment, approval, clock-based
// admission or supplier call is loaded. The recorded policy is not a live readback.
const policy: VideoCostPolicy = {
	moderationBaseMicros: 5_100n,
	moderationPerSecondMicros: 200n,
	audioModerationPerSecondMicros: 0n,
	runtimeMicros: 100_000n,
	storageMicros: 10_000n,
	paymentFixedAllocationMicros: 0n,
	paymentFeeBps: 654n,
	nonBillableFailureBps: 1_000n,
	markupBps: 11_000n,
};
assert.equal(VIDEO_SUPPLIER_PRICE_VERSION, "kie-public-2026-10-07.1");
assert.equal(VIDEO_MODEL_CATALOG_VERSION, "video-models-2026-10-04.2");
const creditFloorMicros = videoPaidCreditFloorMicros();
assert.equal(creditFloorMicros, 21_944n);

const historical = JSON.parse(
	readFileSync(new URL("../../video-v1-prices-2026-10-05.json", import.meta.url), "utf8"),
) as { rows: Array<VideoPricingSelection & { credits?: string }> };
const key = (row: VideoPricingSelection) =>
	[row.productKey, row.mode, row.duration, row.resolution, row.sound].join(":");
const historicalCredits = new Map(historical.rows.map((row) => [key(row), row.credits]));
const rows = [];
for (const productKey of ["video-seedance-2-mini", "video-seedance-2-fast"]) {
	for (const mode of ["text-to-video", "image-to-video"] as const) {
		for (let duration = 4; duration <= 15; duration++) {
			for (const resolution of ["480p", "720p"]) {
				for (const sound of [false, true]) {
					const selection = { productKey, mode, duration, resolution, sound };
					const supplierCostMicros = videoSupplierCostMicros(selection);
					const retail = calculateVideoRetailPrice({
						providerCostMicros: supplierCostMicros,
						duration,
						sound,
						policy,
						creditFloorMicros,
					});
					assert.equal(retail.credits.toString(), historicalCredits.get(key(selection)));
					rows.push({
						...selection,
						supplierCostMicros: supplierCostMicros.toString(),
						credits: retail.credits.toString(),
						minimumPaidGrossMicros: retail.minimumGrossRevenueMicros.toString(),
						completeBudgetMicros: retail.completeCostMicros.toString(),
						profitToBudgetBps: retail.markupBps.toString(),
					});
				}
			}
		}
	}
}
assert.equal(rows.length, 192);
const reference = {
	schemaVersion: 1,
	classification: "CONDITIONAL_REFERENCE_RECORDED_POLICY_NOT_LIVE_RETAIL_OR_INVOICE",
	supplierVersion: VIDEO_SUPPLIER_PRICE_VERSION,
	modelCatalogVersion: VIDEO_MODEL_CATALOG_VERSION,
	publicEvidence: "seedance-public-2026-10-07.json",
	policySource: "../../video-v1-activation-2026-10-05.md",
	policyStatus: "OCTOBER_5_RECORDED_BUDGET_NOT_CURRENT_RUNTIME_READBACK",
	policy: Object.fromEntries(
		Object.entries(policy).map(([name, value]) => [name, value.toString()]),
	),
	creditFloorMicros: creditFloorMicros.toString(),
	conditions: [
		"Current runtime cost policy and operator approval must be read and confirmed before any future release.",
		"Finite VIDEO_PRICE_VALID_UNTIL stays operator-owned; no new deadline is assigned by this calculation.",
		"Both build/runtime targets require compatible supplier version and existing policy; local numbers do not enable a model.",
		"Text/single-image and both sound settings share these supplier budgets; aspect ratios share prices.",
		"Profit-to-budget uses minimum paid gross revenue, not administrator funding or realized account margin.",
	],
	counts: { total: rows.length, perModel: 96 },
	historicalCreditComparison: "ALL_192_MATCH_OCTOBER_5_REFERENCE",
	rows,
};
const output = new URL("seedance-conditional-reference-2026-10-07.json", import.meta.url);
writeFileSync(output, `${JSON.stringify(reference, null, "\t")}\n`);
console.log(`Wrote ${rows.length} conditional rows; all credits match the historical reference.`);
