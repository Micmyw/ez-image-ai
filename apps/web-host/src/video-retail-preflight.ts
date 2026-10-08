import {
	isVideoRetailPricingApproved,
	resolveVideoModelPrice,
	resolveVideoModelCostBasis,
	videoPaidCreditFloorMicros,
	VIDEO_RETAIL_PRICE_VERSION,
	type VideoPricingSelection,
} from "@repo/config/video-pricing.server";
import { expandVideoRuntimeEnvironment } from "@repo/config/video-runtime-environment";

// Build-only approved public prices. Never imported by application or Worker entry points.
import approved from "../../../packages/config/fixtures/video-retail-approved-2026-10-08.json";

export function verifyApprovedVideoRetailPrices(input: Record<string, string | undefined>) {
	const environment = expandVideoRuntimeEnvironment(input);
	if (!isVideoRetailPricingApproved(environment)) return { enabled: false, checked: 0 };
	if (approved.version !== VIDEO_RETAIL_PRICE_VERSION || approved.rows.length !== 1188)
		throw new Error("VIDEO_RETAIL_APPROVAL_MATRIX_INVALID");
	const { policy } = resolveVideoModelCostBasis(
		approved.rows[0]!.selection as VideoPricingSelection,
		environment,
	);
	const costPolicy = {
		...Object.fromEntries(
			Object.entries(policy).map(([key, value]) => [
				key === "markupBps" ? "baseMarkupBps" : key,
				value.toString(),
			]),
		),
		creditFloorMicros: videoPaidCreditFloorMicros().toString(),
	};
	if (policy.markupBps !== 11000n) throw new Error("VIDEO_RETAIL_EXISTING_BASE_MARKUP_CHANGED");
	const differences: object[] = [];
	for (const row of approved.rows) {
		const selection = row.selection as VideoPricingSelection;
		const standard = resolveVideoModelPrice(selection, environment).credits.toString();
		const annual = resolveVideoModelPrice(selection, environment, {
			audience: "annual",
		}).credits.toString();
		if (standard !== row.standardCredits || annual !== row.annualCredits) {
			if (differences.length < 5)
				differences.push({
					selection,
					approvedStandard: row.standardCredits,
					actualStandard: standard,
					approvedAnnual: row.annualCredits,
					actualAnnual: annual,
				});
		}
	}
	// Public credit counts only; private policy and supplier details never leave this boundary.
	if (differences.length)
		throw new Error(`VIDEO_RETAIL_APPROVED_PRICES_CHANGED: ${JSON.stringify(differences)}`);
	return {
		enabled: true,
		policyVersion: VIDEO_RETAIL_PRICE_VERSION,
		checked: approved.rows.length,
		differences: 0,
		costPolicy,
	};
}
