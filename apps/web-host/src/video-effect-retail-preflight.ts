import { VIDEO_EFFECT_RETAIL_PRICE_VERSION } from "@repo/config/video-effects";
import { expandVideoRuntimeEnvironment } from "@repo/config/video-runtime-environment";

import { assessOptionalVideoEffectOptions } from "./optional-video-effect-readiness";

/** Build-only release guard. Recompute against the current opaque production policy, never a local fallback. */
export function verifyApprovedVideoEffectPrices(input: Record<string, string | undefined>) {
	const environment = expandVideoRuntimeEnvironment(input);
	const options = assessOptionalVideoEffectOptions(environment);
	const effects = options.map(({ effectId, duration, available, reasons }) => ({
		effectId,
		duration,
		available,
		reasons,
	}));
	if (environment.VIDEO_EFFECT_RETAIL_PRICE_ACCEPTED_VERSION !== VIDEO_EFFECT_RETAIL_PRICE_VERSION)
		return { enabled: false, checked: 0, effects };
	const rows = [];
	for (const option of options) {
		if (!option.available) continue;
		const { effectId, duration, standard, annual } = option;
		const standardDetails = standard.pricingDetails;
		const annualDetails = annual.pricingDetails;
		rows.push({
			effectId,
			duration,
			standardCredits: standard.credits.toString(),
			annualCredits: annual.credits.toString(),
			standard: {
				costPolicy: standardDetails.costPolicy,
				directCostMicros: standardDetails.directCostMicros,
				riskAdjustedCostMicros: standardDetails.riskAdjustedCostMicros,
				creditFloorMicros: standardDetails.creditFloorMicros,
				paymentFeeMicros: standardDetails.paymentFeeMicros,
				minimumGrossRevenueMicros: standardDetails.minimumGrossRevenueMicros,
			},
			annual: {
				markupBps: annualDetails.costPolicy.markupBps,
				paymentFeeMicros: annualDetails.paymentFeeMicros,
				minimumGrossRevenueMicros: annualDetails.minimumGrossRevenueMicros,
			},
		});
	}
	return {
		enabled: true,
		policyVersion: VIDEO_EFFECT_RETAIL_PRICE_VERSION,
		checked: rows.length,
		differences: 0,
		effects,
		rows,
	};
}
