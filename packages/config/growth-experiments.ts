/** Public, versioned presentation experiments. Never changes prices or entitlements. */
export const GROWTH_EXPERIMENTS = {
	"pricing-default-v1": ["annual", "monthly"],
	"result-purchase-v1": ["control", "guide"],
} as const;
export type GrowthExperimentId = keyof typeof GROWTH_EXPERIMENTS;
export type GrowthExperimentVariant = (typeof GROWTH_EXPERIMENTS)[GrowthExperimentId][number];
export const EXPERIMENT_CONVERSION_WINDOW_MS = 7 * 86_400_000;
export const EXPERIMENT_RETENTION_MS = 90 * 86_400_000;

/** Independent salted buckets from an existing consented random browser identity. */
export function growthExperimentVariant(
	id: GrowthExperimentId,
	sessionHash: string,
): GrowthExperimentVariant {
	let hash = 2166136261;
	for (const char of `${id}:${sessionHash}`) {
		hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
	}
	hash ^= hash >>> 16;
	return GROWTH_EXPERIMENTS[id][hash & 1]!;
}
