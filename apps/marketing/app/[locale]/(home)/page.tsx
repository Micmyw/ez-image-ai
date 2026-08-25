import { FaqSection } from "@home/components/FaqSection";
import {
	type MarketingCheckoutAvailability,
	PricingSection,
} from "@home/components/PricingSection";
import { buildHomeStructuredData, HOME_DESCRIPTION, HOME_TITLE } from "@home/lib/home-seo";
import { config as paymentsConfig } from "@repo/payments/config";
import type { PaidPlan } from "@repo/payments/types";
import { getBaseUrl } from "@shared/lib/base-url";
import type { Metadata } from "next";
import { setRequestLocale } from "next-intl/server";

import { getMarketingImageModes } from "../../../modules/generator/lib/marketing-catalog";
import { BeforeAfterDemo } from "../../../modules/image-editor/components/BeforeAfterDemo";
import { FinalCtaSection } from "../../../modules/image-editor/components/FinalCtaSection";
import { HowItWorksSection } from "../../../modules/image-editor/components/HowItWorksSection";
import { ImageEditorHero } from "../../../modules/image-editor/components/ImageEditorHero";
import { NoRestrictionsSection } from "../../../modules/image-editor/components/NoRestrictionsSection";
import { ShowcaseSection } from "../../../modules/image-editor/components/ShowcaseSection";
import { TrustSection } from "../../../modules/image-editor/components/TrustSection";

export async function generateMetadata({
	params,
}: {
	params: Promise<{ locale: string }>;
}): Promise<Metadata> {
	const { locale } = await params;
	const canonical = new URL(locale === "en" ? "/" : `/${locale}`, getBaseUrl()).href;

	return {
		title: { absolute: HOME_TITLE },
		description: HOME_DESCRIPTION,
		alternates: { canonical },
		openGraph: {
			title: HOME_TITLE,
			description: HOME_DESCRIPTION,
			type: "website",
			url: canonical,
		},
		twitter: {
			card: "summary_large_image",
			title: HOME_TITLE,
			description: HOME_DESCRIPTION,
		},
	};
}

export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
	const { locale } = await params;
	setRequestLocale(locale);
	const structuredData = buildHomeStructuredData(getBaseUrl());
	const imageModes = getMarketingImageModes();
	const checkoutAvailability = marketingCheckoutAvailability();

	return (
		<>
			<script
				type="application/ld+json"
				dangerouslySetInnerHTML={{
					__html: JSON.stringify(structuredData).replaceAll("<", "\\u003c"),
				}}
			/>
			<ImageEditorHero modes={imageModes} />
			<BeforeAfterDemo />
			<ShowcaseSection />
			<NoRestrictionsSection />
			<HowItWorksSection />
			<TrustSection />
			<PricingSection checkoutAvailability={checkoutAvailability} />
			<FaqSection />
			<FinalCtaSection />
		</>
	);
}

function marketingCheckoutAvailability(): MarketingCheckoutAvailability {
	const isConfigured = (planId: "creator" | "studio", interval: "month" | "year") => {
		const plan = paymentsConfig.plans[planId];
		if (!("prices" in plan)) return false;
		return (plan as PaidPlan).prices.some(
			(price) =>
				price.type === "subscription" && price.interval === interval && Boolean(price.priceId),
		);
	};
	return {
		creator: {
			month: isConfigured("creator", "month"),
			year: isConfigured("creator", "year"),
		},
		studio: {
			month: isConfigured("studio", "month"),
			year: isConfigured("studio", "year"),
		},
	};
}
