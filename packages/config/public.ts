import type { GuestMediaConfig } from "./guest-media";
import { PLAN_ENTITLEMENTS } from "./plans";
import { DEFAULT_PRODUCT_CONFIG } from "./product";

export interface PublicGuestMediaConfig {
	enabled: boolean;
	reason: GuestMediaConfig["reason"];
	promotionPeriod: string | null;
	productKey: GuestMediaConfig["productKey"];
	sponsorCredits: string;
	maximumBytes: number;
	mimeTypes: GuestMediaConfig["mimeTypes"];
	turnstileSiteKey: string | null;
}

export function getPublicGuestMediaConfig(config: GuestMediaConfig): PublicGuestMediaConfig {
	return {
		enabled: config.enabled,
		reason: config.reason,
		promotionPeriod: config.promotionPeriod,
		productKey: config.productKey,
		sponsorCredits: config.sponsorCredits.toString(),
		maximumBytes: config.maximumBytes,
		mimeTypes: config.mimeTypes,
		turnstileSiteKey: config.turnstile.siteKey,
	};
}

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
