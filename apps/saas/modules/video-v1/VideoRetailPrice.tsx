"use client";

import { useUpgrade } from "@payments/components/upgrade-context";
import { upgradeHref } from "@payments/lib/upgrade-selection";
import type { VideoRetailDisplay } from "@repo/config/video-pricing.server";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";

import "./video-composer.css";

export function videoAnnualSavings(pricing?: VideoRetailDisplay | null) {
	if (
		!pricing ||
		!/^[1-9]\d{0,15}$/.test(pricing.standardCredits) ||
		!/^[1-9]\d{0,15}$/.test(pricing.annualCredits)
	)
		return null;
	const standard = BigInt(pricing.standardCredits);
	const annual = BigInt(pricing.annualCredits);
	if (annual >= standard) return null;
	return {
		credits: (standard - annual).toString(),
		percent: Number(((standard - annual) * 1000n) / standard) / 10,
	};
}

export function VideoAnnualBadge({ pricing }: { pricing?: VideoRetailDisplay | null }) {
	const t = useTranslations("videoV1.retail");
	const savings = videoAnnualSavings(pricing);
	return savings ? (
		<span className="video-annual-badge">{t("badge", { percent: savings.percent })}</span>
	) : null;
}

export function VideoAnnualBanner({
	pricing,
	disabled = false,
}: {
	pricing?: VideoRetailDisplay | null;
	disabled?: boolean;
}) {
	const t = useTranslations("videoV1.retail");
	const locale = useLocale();
	const upgrade = useUpgrade();
	if (!pricing) return null;
	const selection = { planId: "creator", interval: "year" } as const;
	const savings = videoAnnualSavings(pricing);
	return (
		<div className="video-annual-banner" data-test="video-annual-banner">
			<div>
				<strong>{t(pricing.audience === "annual" ? "activeTitle" : "title")}</strong>
				<p>
					{savings
						? t("selectedPrices", {
								standard: pricing.standardCredits,
								annual: pricing.annualCredits,
							})
						: t("description")}
				</p>
			</div>
			{pricing.audience === "standard" &&
				(upgrade ? (
					<button type="button" disabled={disabled} onClick={() => upgrade(selection)}>
						{t("viewPlans")}
					</button>
				) : (
					<Link href={upgradeHref(selection, locale)}>{t("viewPlans")}</Link>
				))}
		</div>
	);
}

export function VideoRetailPrice({ pricing }: { pricing?: VideoRetailDisplay | null }) {
	const t = useTranslations("videoV1.retail");
	if (!pricing) return null;
	const savings = videoAnnualSavings(pricing);
	return (
		<div className="video-retail-price" data-test="video-retail-price" aria-live="polite">
			{pricing.audience === "annual" ? (
				<>
					{savings && (
						<span>
							{t("standard")} <s>{t("credits", { credits: pricing.standardCredits })}</s>
						</span>
					)}
					<strong>
						{t("annual")} {t("credits", { credits: pricing.annualCredits })}
					</strong>
					{savings && (
						<span className="video-retail-saving">
							{t("saving", { credits: savings.credits, percent: savings.percent })}
						</span>
					)}
				</>
			) : (
				<>
					<strong>
						{t("standard")} {t("credits", { credits: pricing.standardCredits })}
					</strong>
					{savings && (
						<span>
							{t("annual")} {t("credits", { credits: pricing.annualCredits })}
							<span className="video-retail-saving">
								{" "}
								· {t("saving", { credits: savings.credits, percent: savings.percent })}
							</span>
						</span>
					)}
				</>
			)}
			{!savings && <span>{t("samePrice")}</span>}
		</div>
	);
}
