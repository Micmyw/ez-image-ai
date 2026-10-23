"use client";

import { Button } from "@repo/ui/components/button";
import { useGrowthExperiment } from "@shared/hooks/use-growth-experiment";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";

/** Mounted only after a successful account result image actually loads. */
export function ResultPurchaseGuide() {
	const t = useTranslations("pricing.resultGuide");
	const locale = useLocale();
	const experiment = useGrowthExperiment("result-purchase-v1");
	// The shared observer gives both arms the same eligibility/visibility denominator.
	return (
		<div data-test="result-purchase-experiment">
			<div ref={experiment.exposureRef} className="h-px" aria-hidden="true" />
			{experiment.variant === "guide" && (
				<aside className="mt-5 p-4 space-y-2 rounded-xl border bg-muted/30">
					<h3 className="font-medium">{t("title")}</h3>
					<p className="text-sm text-muted-foreground">{t("description")}</p>
					<Button
						variant="secondary"
						render={(props) => (
							<Link
								{...props}
								href={locale === "en" ? "/pricing" : `/pricing?lang=${locale}`}
								onClick={experiment.trackClick}
							/>
						)}
					>
						{t("action")}
					</Button>
				</aside>
			)}
		</div>
	);
}
