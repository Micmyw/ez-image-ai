"use client";

import { useUpgrade } from "@payments/components/upgrade-context";
import { usePaymentAction } from "@payments/hooks/use-payment-action";
import { calculateAnnualPlanPricing } from "@payments/lib/annual-plan-pricing";
import { defaultUpgradeSelection, upgradeHref } from "@payments/lib/upgrade-selection";
import { PLAN_ENTITLEMENTS } from "@repo/config/client";
import { LocaleSwitch } from "@shared/components/LocaleSwitch";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { CoinsIcon, CrownIcon, Loader2Icon, PlusIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";

export function HeaderPurchaseActions({ registered }: { registered: boolean }) {
	const t = useTranslations("pricing.upgrade");
	const locale = useLocale();
	const openUpgrade = useUpgrade();
	const payment = usePaymentAction();
	const account = useQuery({
		queryKey: ["media-credit-account"],
		queryFn: () => orpcClient.media.getCreditAccount(),
		enabled: registered,
		refetchInterval: 30_000,
	});
	const savings = calculateAnnualPlanPricing(
		PLAN_ENTITLEMENTS.find((plan) => plan.id === "ultimate")?.prices ?? [],
	);
	const balance = account.data?.spendableCredits;
	return (
		<div className="studio-purchase-actions">
			<Link
				href={upgradeHref(defaultUpgradeSelection, locale)}
				className="studio-upgrade"
				data-test="header-upgrade"
				aria-disabled={Boolean(payment.action)}
				onClick={(event) => {
					if (payment.action) {
						event.preventDefault();
						return;
					}
					if (openUpgrade && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
						event.preventDefault();
						openUpgrade(defaultUpgradeSelection);
					}
				}}
			>
				<CrownIcon aria-hidden />
				<span>{t("button")}</span>
				{savings && <span className="studio-upgrade-saving">−{savings.savingsPercent}%</span>}
			</Link>
			<LocaleSwitch className="studio-language" disabled={Boolean(payment.action)} />
			{registered && (
				<button
					type="button"
					className="studio-header-credits"
					data-test="header-credits"
					disabled={Boolean(payment.action)}
					onClick={() => openUpgrade?.({ ...defaultUpgradeSelection, view: "credit-packs" })}
					aria-label={
						balance !== undefined
							? t("creditsLabel", { credits: balance })
							: t("creditsUnavailable")
					}
					title={
						balance !== undefined
							? t("creditsLabel", { credits: balance })
							: t("creditsUnavailable")
					}
				>
					<CoinsIcon aria-hidden />
					<span>
						{balance !== undefined ? (
							new Intl.NumberFormat(locale).format(BigInt(balance))
						) : account.isPending ? (
							<Loader2Icon className="animate-spin" aria-hidden />
						) : (
							"—"
						)}
					</span>
					<PlusIcon className="studio-credits-plus" aria-hidden />
				</button>
			)}
		</div>
	);
}
