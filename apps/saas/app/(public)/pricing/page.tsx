import { ChevronDownIcon } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { PRICING_FAQ_KEYS } from "../../../modules/landing/lib/faq";
import { PublicPricingPlans } from "../../../modules/payments/components/PublicPricingPlans";
import { PublicPageShell } from "../../../modules/public-content/components/PublicPageShell";
import { createPublicPageMetadata } from "../../../modules/public-content/lib/metadata";

export async function generateMetadata() {
	const t = await getTranslations();
	return createPublicPageMetadata({
		path: "/pricing",
		title: t("pricing.title"),
		description: t("pricing.description"),
		index: true,
	});
}

export default async function PricingPage() {
	const locale = await getLocale();
	const t = await getTranslations();

	return (
		<PublicPageShell title={t("pricing.title")} description={t("pricing.description")}>
			<PublicPricingPlans locale={locale} />
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
