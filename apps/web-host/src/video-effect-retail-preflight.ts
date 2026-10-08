import { VIDEO_EFFECT_RETAIL_PRICE_VERSION } from "@repo/config/video-effects";
import {
	isVideoEffectRetailPricingApproved,
	resolveVideoEffectPrice,
} from "@repo/config/video-effects.server";
import { expandVideoRuntimeEnvironment } from "@repo/config/video-runtime-environment";

/** Build-only release guard. Recompute against the current opaque production policy, never a local fallback. */
export function verifyApprovedVideoEffectPrices(input: Record<string, string | undefined>) {
	const environment = expandVideoRuntimeEnvironment(input);
	if (!isVideoEffectRetailPricingApproved(environment)) return { enabled: false, checked: 0 };
	const rows = [];
	for (const effectId of ["hotel-lobby-duo", "raindance-solo", "raindance-duo"] as const) {
		for (const duration of [5, 10] as const) {
			const request = {
				effectId,
				presetKey: "standard" as const,
				...(duration === 10 ? { duration: 10 as const } : {}),
				inputs: { leftAssetId: "preflight", rightAssetId: "preflight" },
			};
			const standard = resolveVideoEffectPrice(request, environment);
			const annual = resolveVideoEffectPrice(request, environment, { audience: "annual" });
			if (
				standard.credits !== (duration === 5 ? 69n : 116n) ||
				annual.credits !== (duration === 5 ? 69n : 101n)
			) {
				throw new Error(
					`VIDEO_EFFECT_APPROVED_PRICES_CHANGED: ${JSON.stringify({ effectId, duration, standard: standard.credits.toString(), annual: annual.credits.toString() })}`,
				);
			}
			const standardDetails = standard.pricingDetails;
			const annualDetails = annual.pricingDetails;
			if (
				standardDetails.costPolicy.markupBps !== (duration === 5 ? "20000" : "27500") ||
				annualDetails.costPolicy.markupBps !== (duration === 5 ? "20000" : "23750")
			)
				throw new Error("VIDEO_EFFECT_APPROVED_MARKUP_CHANGED");
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
	}
	return {
		enabled: true,
		policyVersion: VIDEO_EFFECT_RETAIL_PRICE_VERSION,
		checked: rows.length,
		differences: 0,
		rows,
	};
}
