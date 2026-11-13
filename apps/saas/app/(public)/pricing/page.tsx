import { IMAGE_PASS_OFFER_SUMMARY } from "@repo/config/image-pass-summary";
import { ArrowRightIcon, ChevronDownIcon, SparklesIcon } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";

import { PRICING_FAQ_KEYS } from "../../../modules/landing/lib/faq";
import { PublicPricingPlans } from "../../../modules/payments/components/PublicPricingPlans";
import { sanitizeEditorReturnPath } from "../../../modules/payments/lib/editor-upgrade";
import { PublicPageShell } from "../../../modules/public-content/components/PublicPageShell";
import type { PublicMetadataProps } from "../../../modules/public-content/lib/indexing";
import { createPublicPageMetadata } from "../../../modules/public-content/lib/metadata";

export async function generateMetadata(props: PublicMetadataProps) {
	const { searchParams } = props ?? {};
	const t = await getTranslations();
	return createPublicPageMetadata({
		searchParams: await searchParams,
		path: "/pricing",
		title: t("pricing.title"),
		description: t("pricing.description"),
		index: true,
	});
}

export default async function PricingPage({ searchParams }: PublicMetadataProps) {
	const locale = await getLocale();
	const t = await getTranslations();
	const params = await searchParams;
	const interval = params?.interval;
	const returnTo =
		typeof params?.returnTo === "string" ? sanitizeEditorReturnPath(params.returnTo) : null;
	const offer = IMAGE_PASS_OFFER_SUMMARY;

	return (
		<PublicPageShell title={t("pricing.title")} description={t("pricing.description")}>
			{returnTo && (
				<div className="mb-6 text-center">
					<Link className="text-sm text-violet-200 underline underline-offset-4" href={returnTo}>
						{t("media.upgradeDialog.cancel")}
					</Link>
				</div>
			)}
			<section
				aria-label={t("imagePass.bannerLabel")}
				data-test="pricing-image-pass"
				className="mb-6 gap-5 border-violet-300/20 from-violet-400/10 to-white/[0.03] p-6 sm:p-7 flex flex-wrap items-center justify-between rounded-3xl border bg-gradient-to-r"
			>
				<div className="gap-4 flex items-start">
					<SparklesIcon className="mt-1 size-6 text-violet-200 shrink-0" aria-hidden />
					<div>
						<h2 className="text-xl font-semibold text-white">
							{t("imagePass.bannerTitle", { units: offer.units, amount: offer.amount })}
						</h2>
						<p className="mt-2 text-sm leading-6 text-slate-300">{t("imagePass.bannerDetail")}</p>
					</div>
				</div>
				<Link
					href="/image-pass"
					className="min-h-11 gap-2 bg-violet-500 px-5 text-sm font-semibold text-white hover:bg-violet-400 inline-flex items-center rounded-xl transition"
				>
					{t("imagePass.buy")}
					<ArrowRightIcon className="size-4" aria-hidden />
				</Link>
			</section>
			<PublicPricingPlans
				locale={locale}
				initialView={interval === "month" || interval === "year" ? interval : undefined}
			/>
			<section aria-labelledby="pricing-faq-title" className="mt-20 max-w-3xl mx-auto">
				<div className="text-center">
					<h2 id="pricing-faq-title" className="text-3xl font-semibold text-white">
						{t("pricing.pricingFaqTitle")}
					</h2>
					<p className="mt-3 text-base leading-7 text-slate-300">
						{t("pricing.pricingFaqDescription")}
					</p>
				</div>
				<div className="mt-8 space-y-3">
					{PRICING_FAQ_KEYS.map((key) => (
						<details
							key={key}
							className="group border-white/10 bg-white/[0.045] p-5 open:border-violet-400/40 rounded-2xl border"
						>
							<summary className="focus-visible:outline-violet-300 gap-4 font-semibold text-white flex cursor-pointer list-none items-center justify-between rounded-md focus-visible:outline-2 focus-visible:outline-offset-4">
								<span>{t(`faq.items.${key}.question`)}</span>
								<ChevronDownIcon
									className="size-4 text-violet-300 shrink-0 transition-transform group-open:rotate-180"
									aria-hidden="true"
								/>
							</summary>
							<p className="mt-3 text-sm leading-6 text-slate-300">
								{t(`faq.items.${key}.answer`)}
							</p>
						</details>
					))}
				</div>
			</section>
		</PublicPageShell>
	);
}
