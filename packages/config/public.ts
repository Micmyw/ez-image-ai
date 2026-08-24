import { PLAN_ENTITLEMENTS } from "./plans";
import { DEFAULT_PRODUCT_CONFIG } from "./product";

export interface PublicConfig {
	catalogVersion: string;
	pricingVersion: string;
	brand: typeof DEFAULT_PRODUCT_CONFIG.brand;
	features: typeof DEFAULT_PRODUCT_CONFIG.features;
	uploadLimits: typeof DEFAULT_PRODUCT_CONFIG.uploadLimits;
	publicUrls: typeof DEFAULT_PRODUCT_CONFIG.publicUrls;
	enabledLocales: string[];
	plans: Array<{
		id: string;
		monthlyCredits: number;
		maximumConcurrentJobs: number;
		maximumInputBytes: number;
		allowedProducts: string[];
	}>;
}

export function getPublicConfig(): PublicConfig {
	return {
		catalogVersion: DEFAULT_PRODUCT_CONFIG.catalogVersion,
		pricingVersion: DEFAULT_PRODUCT_CONFIG.pricingVersion,
		brand: { ...DEFAULT_PRODUCT_CONFIG.brand },
		features: { ...DEFAULT_PRODUCT_CONFIG.features },
		uploadLimits: { ...DEFAULT_PRODUCT_CONFIG.uploadLimits },
		publicUrls: { ...DEFAULT_PRODUCT_CONFIG.publicUrls },
		enabledLocales: [...DEFAULT_PRODUCT_CONFIG.enabledLocales],
		plans: PLAN_ENTITLEMENTS.map(
			({ id, monthlyCredits, maximumConcurrentJobs, maximumInputBytes, allowedProducts }) => ({
				id,
				monthlyCredits,
				maximumConcurrentJobs,
				maximumInputBytes,
				allowedProducts: [...allowedProducts],
			}),
		),
	};
}
