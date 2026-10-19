import {
	resolveVideoEffectPrice,
	assertApprovedVideoEffectRetailPrice,
} from "@repo/config/video-effects.server";
import { expandVideoRuntimeEnvironment } from "@repo/config/video-runtime-environment";

// Only refusal codes enforced by the unchanged new-order price/template resolver.
// Transport errors, ordinary-video policy errors and unknown exceptions remain fatal.
const optionalPolicyRefusals = new Set([
	"VIDEO_EFFECT_TEMPLATE_NOT_CONFIRMED",
	"VIDEO_EFFECT_PRICE_NOT_APPROVED",
	"VIDEO_EFFECT_COST_POLICY_NOT_CONFIRMED",
	"VIDEO_EFFECT_COST_POLICY_NOT_CONFIGURED",
	"VIDEO_EFFECT_PAYMENT_COST_NOT_CONFIRMED",
	"VIDEO_EFFECT_TEXT_COST_NOT_CONFIRMED",
	"VIDEO_EFFECT_PRICING_TARGET_INVALID",
	"VIDEO_EFFECT_APPROVED_PRICES_CHANGED",
	"VIDEO_EFFECT_APPROVED_MARKUP_CHANGED",
]);

const fatalPolicyRefusals = new Set([
	"VIDEO_RUNTIME_CONFIG_INVALID",
	"VIDEO_RUNTIME_CONFIG_CONFLICT",
	"VIDEO_MODEL_SELECTION_UNSUPPORTED",
	"VIDEO_MODEL_PRICE_UNAVAILABLE",
	"VIDEO_PRICE_NOT_APPROVED",
	"VIDEO_COST_POLICY_NOT_CONFIGURED",
	"VIDEO_VISUAL_COST_POLICY_NOT_CONFIRMED",
	"VIDEO_TEXT_COST_POLICY_NOT_CONFIRMED",
	"VIDEO_RETAIL_PRICE_NOT_APPROVED",
	"VIDEO_RETAIL_AUDIENCE_INVALID",
	"VIDEO_PRICE_INVALID",
	"VIDEO_CREDIT_REVENUE_UNVERIFIED",
	"VIDEO_PROFIT_FLOOR_NOT_MET",
]);

/** Build-only assessment. Preserve flags and opaque policy for accepted-order recovery. */
export function assessOptionalVideoEffectOptions(input: Record<string, string | undefined>) {
	// Deliberately outside the optional refusal catch: malformed/conflicting policy is fatal.
	const environment = expandVideoRuntimeEnvironment(input);
	return (["hotel-lobby-duo", "raindance-solo", "raindance-duo"] as const).flatMap((effectId) =>
		([5, 10] as const).map((duration) => {
			const option = { effectId, duration };
			const enabled =
				environment[
					effectId === "hotel-lobby-duo" ? "HOTEL_LOBBY_DUO_ENABLED" : "RAINDANCE_ENABLED"
				];
			if (enabled !== "true")
				return { ...option, available: false as const, reasons: ["VIDEO_EFFECT_DISABLED"] };
			if (environment.VIDEO_V1_ENABLED !== "true")
				return { ...option, available: false as const, reasons: ["VIDEO_EFFECT_VIDEO_DISABLED"] };
			try {
				const request = {
					effectId,
					presetKey: "standard" as const,
					...(duration === 10 ? { duration: 10 as const } : {}),
					inputs: { leftAssetId: "readiness", rightAssetId: "readiness" },
				};
				const standard = resolveVideoEffectPrice(request, environment);
				assertApprovedVideoEffectRetailPrice(request, environment, standard);
				const annual = resolveVideoEffectPrice(request, environment, { audience: "annual" });
				assertApprovedVideoEffectRetailPrice(request, environment, annual, { audience: "annual" });
				return {
					...option,
					available: true as const,
					reasons: [],
					standard,
					annual,
				};
			} catch (error) {
				if (error instanceof Error && optionalPolicyRefusals.has(error.message))
					return { ...option, available: false as const, reasons: [error.message] };
				if (error instanceof Error && fatalPolicyRefusals.has(error.message)) throw error;
				// Unknown exceptions remain fatal without logging arbitrary supplied values.
				throw new Error("VIDEO_EFFECT_BUILD_READINESS_FAILED");
			}
		}),
	);
}
