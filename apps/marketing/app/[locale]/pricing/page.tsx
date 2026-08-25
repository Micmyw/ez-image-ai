import { PricingSection } from "@home/components/PricingSection";
import { getMarketingCheckoutAvailability } from "@home/lib/pricing";
import { getApprovedMarketingPageRobots } from "@i18n/config";
import { getBaseUrl } from "@shared/lib/base-url";
import type { Metadata } from "next";
import { setRequestLocale } from "next-intl/server";

const PRICING_TITLE = "AI Image Editor Pricing | EzPic";
const PRICING_DESCRIPTION =
	"Compare EzPic Free, Creator, and Studio plans with transparent monthly credits and image editing limits.";

export async function generateMetadata({
	params,
}: {
	params: Promise<{ locale: string }>;
}): Promise<Metadata> {
	const { locale } = await params;
	const canonical = new URL("/pricing", getBaseUrl()).href;
	return {
		title: { absolute: PRICING_TITLE },
		description: PRICING_DESCRIPTION,
		alternates: { canonical },
		robots: getApprovedMarketingPageRobots(locale, "/pricing"),
		openGraph: {
			title: PRICING_TITLE,
			description: PRICING_DESCRIPTION,
			type: "website",
			url: canonical,
		},
		twitter: {
			card: "summary_large_image",
			title: PRICING_TITLE,
			description: PRICING_DESCRIPTION,
		},
	};
}

export default async function PricingPage({ params }: { params: Promise<{ locale: string }> }) {
	const { locale } = await params;
	setRequestLocale(locale);
	return (
		<>
			<header className="max-w-4xl py-16 sm:py-20 container text-center">
				<h1 className="text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
					Simple, transparent pricing for private image edits
				</h1>
				<p className="mt-5 max-w-2xl text-lg leading-8 text-slate-600 mx-auto">
					Choose monthly credits and concurrency that fit your editing workflow. Every real edit
					uses the same private, moderated generation path.
				</p>
			</header>
			<PricingSection
				checkoutAvailability={getMarketingCheckoutAvailability()}
				showHeading={false}
			/>
		</>
	);
}
