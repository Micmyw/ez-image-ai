import { config } from "@config";
import { PLAN_ENTITLEMENTS } from "@repo/config/client";

import { type MarketingCheckoutAvailability, unavailableMarketingCheckout } from "./pricing";

export const HOME_TITLE = "AI Image Editor No Restrictions — Edit Images with Prompts | EzPic";
export const HOME_DESCRIPTION =
	"Upload an image and describe the change. Edit backgrounds, objects, colors, lighting and styles with private AI image editing and transparent credits. Start with free credits.";

export function buildHomeStructuredData(
	baseUrl: string,
	checkoutAvailability: MarketingCheckoutAvailability = unavailableMarketingCheckout,
) {
	const canonical = new URL("/", baseUrl).href;
	const pricingUrl = new URL("/pricing", baseUrl).href;
	const offers = PLAN_ENTITLEMENTS.flatMap((plan) => {
		const planId = plan.id;
		if (planId !== "creator" && planId !== "studio") return [];
		const availability = checkoutAvailability[planId];
		return plan.prices
			.filter((price) => availability[price.interval])
			.map((price) => ({
				"@type": "Offer",
				name: `${planId === "creator" ? "Creator" : "Studio"} ${price.interval === "month" ? "monthly" : "yearly"}`,
				price: String(price.amount),
				priceCurrency: price.currency,
				availability: "https://schema.org/InStock",
				url: pricingUrl,
			}));
	});
	return {
		"@context": "https://schema.org",
		"@graph": [
			{
				"@type": "WebSite",
				"@id": `${canonical}#website`,
				name: config.appName,
				url: canonical,
			},
			{
				"@type": "Organization",
				"@id": `${canonical}#organization`,
				name: config.appName,
				url: canonical,
			},
			{
				"@type": "SoftwareApplication",
				"@id": `${canonical}#application`,
				name: config.appName,
				applicationCategory: "MultimediaApplication",
				operatingSystem: "Web",
				description: HOME_DESCRIPTION,
				url: canonical,
				...(offers.length ? { offers } : {}),
			},
		],
	};
}
