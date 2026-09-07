"use client";

import { getPlanUsageEstimate, PLAN_ENTITLEMENTS, PUBLIC_CREDIT_PACKS } from "@repo/config/client";
import {
	ArrowRightIcon,
	CalendarClockIcon,
	CheckIcon,
	CoinsIcon,
	CropIcon,
	CrownIcon,
	HistoryIcon,
	Layers3Icon,
	LockKeyholeIcon,
	SparklesIcon,
	WandSparklesIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { type ComponentType, type ReactNode, useState } from "react";

import {
	calculateAnnualBillingPrice,
	calculateAnnualPlanPricing,
	hasCompleteAnnualBilling,
} from "../lib/annual-plan-pricing";
import { CreditPackCheckoutActions } from "./CreditPackCheckoutActions";

const planIds = ["creator", "ultimate", "studio"] as const;

type PricingView = "month" | "year" | "credit-packs";

export function PublicPricingPlans({
	className,
	headingLevel = 2,
	locale,
}: {
	className?: string;
	headingLevel?: 2 | 3;
	locale: string;
}) {
	const t = useTranslations();
	const [view, setView] = useState<PricingView>("year");
	const PlanHeading = headingLevel === 2 ? "h2" : "h3";
	const plans = planIds.flatMap((planId) => {
		const entitlement = PLAN_ENTITLEMENTS.find((plan) => plan.id === planId);
		return entitlement ? [{ entitlement, planId }] : [];
	});
	const billablePriceSets = plans.map(({ entitlement }) => entitlement.prices);
	const annualPricings = plans
		.map(({ entitlement }) => calculateAnnualPlanPricing(entitlement.prices))
		.filter((pricing) => pricing !== null);
	const hasAnnualPricing = hasCompleteAnnualBilling(billablePriceSets);
	const firstAnnualPricing = annualPricings[0];
	const sharedSavingsPercent =
		hasAnnualPricing &&
		annualPricings.length === plans.length &&
		firstAnnualPricing &&
		annualPricings.every((pricing) => pricing.savingsPercent === firstAnnualPricing.savingsPercent)
			? firstAnnualPricing.savingsPercent
			: null;
	const showingCreditPacks = view === "credit-packs";

	return (
		<div className={className} data-test="public-pricing-plans">
			<div className="border-white/9 p-3 sm:p-5 lg:p-7 overflow-hidden rounded-[2.25rem] border bg-[radial-gradient(circle_at_50%_-12rem,rgba(151,116,255,0.18),transparent_31rem),linear-gradient(145deg,rgba(29,20,42,0.98),rgba(20,14,30,0.98))] shadow-[0_36px_110px_-70px_rgba(141,104,255,0.95),inset_0_1px_0_rgba(255,255,255,0.055)]">
				<div className="flex justify-center">
					<fieldset className="border-white/10 p-1 min-w-0 inline-flex max-w-full overflow-x-auto rounded-full border bg-[#0f0a17]/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
						<legend className="sr-only">
							{t("pricing.monthly")}, {t("pricing.yearly")}, {t("pricing.creditPacks")}
						</legend>
						<PricingViewButton
							active={view === "month"}
							onClick={() => setView("month")}
							dataTest="public-pricing-interval-month"
							controls="public-subscription-pricing"
						>
							{t("pricing.monthly")}
						</PricingViewButton>
						<PricingViewButton
							active={view === "year"}
							onClick={() => setView("year")}
							dataTest="public-pricing-interval-year"
							controls="public-subscription-pricing"
						>
							{t("pricing.yearly")}
							{sharedSavingsPercent !== null && (
								<span className="px-1.5 py-0.5 sm:px-2 font-bold text-white rounded-full bg-[#f05f71] text-[0.68rem]">
									-{sharedSavingsPercent}%
								</span>
							)}
						</PricingViewButton>
						<PricingViewButton
							active={showingCreditPacks}
							onClick={() => setView("credit-packs")}
							dataTest="public-pricing-credit-packs-tab"
							controls="public-credit-pack-pricing"
						>
							{t("pricing.creditPacks")}
						</PricingViewButton>
					</fieldset>
				</div>

				<div
					id="public-subscription-pricing"
					hidden={showingCreditPacks}
					className="mt-6 gap-3 lg:grid-cols-3 lg:items-stretch grid"
				>
					{plans.map(({ entitlement, planId }) => {
						const monthlyPrice = entitlement.prices.find((price) => price.interval === "month");
						const annualBilling = calculateAnnualBillingPrice(entitlement.prices);
						const annualPricing = calculateAnnualPlanPricing(entitlement.prices);
						const showAnnualPrice = view === "year" && annualBilling !== null;
						const usage = getPlanUsageEstimate(entitlement.id);
						const hasQualityAccess = entitlement.allowedProducts.includes("image-quality");
						const recommended = planId === "ultimate";
						const benefits = [
							t("pricing.monthlyCredits", { credits: entitlement.monthlyCredits }),
							usage.qualityEdits === null
								? t("pricing.monthlyStandardAllowance", { standard: usage.standardEdits })
								: t("pricing.monthlyEditAllowance", {
										standard: usage.standardEdits,
										quality: usage.qualityEdits,
									}),
							t("pricing.concurrentEdits", { count: entitlement.maximumConcurrentJobs }),
							t("pricing.maximumInputSize", {
								megabytes: Math.round(entitlement.maximumInputBytes / 1024 / 1024),
							}),
						];
						const displayAmount = showAnnualPrice
							? annualBilling.monthlyEquivalent
							: (monthlyPrice?.amount ?? 0);
						const displayCurrency = annualBilling?.currency ?? monthlyPrice?.currency ?? "USD";

						return (
							<article
								key={planId}
								data-plan-id={planId}
								data-recommended={recommended ? "true" : undefined}
								data-test="public-pricing-plan"
								className={`p-5 sm:p-6 relative flex min-h-[36rem] flex-col overflow-hidden rounded-[1.6rem] border ${
									recommended
										? "border-[#9f83ff]/70 bg-[linear-gradient(165deg,rgba(72,51,108,0.88),rgba(43,29,65,0.96))] shadow-[0_24px_65px_-38px_rgba(143,108,255,0.95),inset_0_1px_0_rgba(255,255,255,0.1)]"
										: "border-white/9 bg-white/[0.035] shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]"
								}`}
							>
								{recommended && (
									<div
										className="-top-24 -right-16 blur-3xl size-60 pointer-events-none absolute rounded-full bg-[#b09bff]/18"
										aria-hidden="true"
									/>
								)}
								<div className="relative flex h-full flex-col">
									<div className="gap-3 flex items-start justify-between">
										<PlanHeading className="text-2xl font-semibold text-white tracking-[-0.035em]">
											{t(`pricing.products.${planId}.title`)}
										</PlanHeading>
										{recommended && (
											<span className="px-2.5 py-1 font-bold shrink-0 rounded-full border border-[#d6cbff]/25 bg-[#bcaaff]/14 text-[0.66rem] tracking-[0.07em] text-[#ede8ff] uppercase">
												{t("pricing.recommended")}
											</span>
										)}
									</div>
									<p className="mt-2 min-h-11 text-sm leading-5 text-[#bdb3c5]">
										{t(`pricing.products.${planId}.description`)}
									</p>

									<div className="mt-5">
										{showAnnualPrice && annualPricing && monthlyPrice && (
											<p className="text-xs text-[#94899e] line-through" aria-hidden="true">
												{formatCurrency(locale, monthlyPrice.amount, monthlyPrice.currency)}
											</p>
										)}
										<p className="mt-0.5 text-white flex items-end">
											<strong
												className="font-semibold text-[2.8rem] leading-none tracking-[-0.055em]"
												data-test={`public-pricing-${planId}-price`}
											>
												{formatCurrency(locale, displayAmount, displayCurrency)}
											</strong>
											<span className="mb-1 ml-1 text-sm text-[#9f94a8]">
												/{t("pricing.month", { count: 1 })}
											</span>
										</p>
										{showAnnualPrice && annualPricing && (
											<p
												className="mt-2 min-h-10 text-xs leading-5 text-[#c2b7ca]"
												data-test={`public-pricing-${planId}-annual-summary`}
											>
												{t("pricing.annualSummary", {
													total: formatCurrency(
														locale,
														annualPricing.total,
														annualPricing.currency,
													),
													savings: formatCurrency(
														locale,
														annualPricing.savings,
														annualPricing.currency,
													),
													percent: annualPricing.savingsPercent,
												})}
											</p>
										)}
										{showAnnualPrice && !annualPricing && (
											<p className="mt-2 min-h-10 text-xs leading-5 text-[#c2b7ca]">
												{t("pricing.annualTotal", {
													total: formatCurrency(
														locale,
														annualBilling.total,
														annualBilling.currency,
													),
												})}
											</p>
										)}
									</div>

									<Link
										href="/signup"
										className={`mt-3 min-h-11 px-5 text-sm font-semibold focus-visible:outline-violet-200 inline-flex w-full items-center justify-center rounded-xl border transition focus-visible:outline-2 focus-visible:outline-offset-2 ${
											recommended
												? "text-white border-transparent bg-[#7453ff] shadow-[0_14px_32px_-18px_rgba(116,83,255,1)] hover:bg-[#8267ff]"
												: "border-white/12 bg-white/[0.055] text-white hover:bg-white/[0.09] hover:border-[#a98bff]/35"
										}`}
									>
										{t("pricing.getStarted")}
										<ArrowRightIcon className="ml-2 size-4" aria-hidden="true" />
									</Link>

									<CapabilityRail hasQualityAccess={hasQualityAccess} />

									<ul className="border-white/8 mt-5 space-y-2.5 pt-5 text-sm leading-5 border-t text-[#d8cfdd]">
										{benefits.map((benefit) => (
											<li key={benefit} className="gap-2.5 flex items-start">
												<CheckIcon
													className="mt-0.5 size-4 shrink-0 text-[#bcaaff]"
													strokeWidth={2.25}
													aria-hidden="true"
												/>
												<span>{benefit}</span>
											</li>
										))}
									</ul>
								</div>
							</article>
						);
					})}
				</div>

				<div
					id="public-credit-pack-pricing"
					data-test="public-pricing-credit-packs"
					hidden={!showingCreditPacks}
					className="mt-6"
				>
					<div className="gap-3 px-4 py-3 sm:px-5 text-sm font-semibold flex items-center justify-center rounded-2xl border border-[#b79cff]/16 bg-[#b79cff]/[0.055] text-center text-[#eee9ff]">
						<CrownIcon className="size-5 shrink-0 text-[#c7b8ff]" aria-hidden="true" />
						{t("pricing.subscriberBonus", {
							percent: PUBLIC_CREDIT_PACKS[0]?.subscriberBonusPercent ?? 20,
						})}
					</div>
					<div className="mt-3 gap-3 md:grid-cols-2 xl:grid-cols-4 grid">
						{PUBLIC_CREDIT_PACKS.map((pack) => (
							<article
								key={pack.packKey}
								data-pack-key={pack.packKey}
								data-test="public-credit-pack"
								className="border-white/9 bg-white/[0.035] p-5 hover:-translate-y-1 hover:bg-white/[0.055] flex min-h-[23rem] flex-col rounded-[1.5rem] border shadow-[inset_0_1px_0_rgba(255,255,255,0.035)] transition hover:border-[#a98bff]/35 hover:shadow-[0_24px_60px_-42px_rgba(136,100,255,0.9)] motion-reduce:transform-none"
							>
								<div className="gap-2 text-white flex items-center">
									<span className="size-8 inline-flex items-center justify-center rounded-xl border border-[#b79cff]/20 bg-[#b79cff]/10">
										<CoinsIcon className="size-4 text-[#c7b8ff]" aria-hidden="true" />
									</span>
									<PlanHeading className="text-lg font-semibold tracking-[-0.025em]">
										{t("pricing.creditPackTitle", {
											credits: formatNumber(locale, pack.baseCredits),
										})}
									</PlanHeading>
								</div>
								<p className="mt-5 text-white flex items-end">
									<strong className="text-4xl font-semibold leading-none tracking-[-0.05em]">
										{formatCurrency(locale, pack.price.amount, pack.price.currency)}
									</strong>
									<span className="mb-0.5 ml-2 text-xs text-[#9f94a8]">{t("pricing.oneTime")}</span>
								</p>
								<p className="mt-3 text-sm font-semibold leading-5 text-[#c7b8ff]">
									{t("pricing.subscriberReceives", {
										credits: formatNumber(locale, pack.subscriberCredits),
									})}
								</p>
								<ul className="mt-5 space-y-3 text-sm leading-5 text-[#d8cfdd]">
									<li className="gap-2.5 flex items-start">
										<Layers3Icon
											className="mt-0.5 size-4 shrink-0 text-[#bcaaff]"
											aria-hidden="true"
										/>
										{t("pricing.baseCredits", {
											credits: formatNumber(locale, pack.baseCredits),
										})}
									</li>
									<li className="gap-2.5 flex items-start">
										<SparklesIcon
											className="mt-0.5 size-4 shrink-0 text-[#bcaaff]"
											aria-hidden="true"
										/>
										{t("pricing.subscriberBonusAmount", {
											credits: formatNumber(locale, pack.subscriberCredits - pack.baseCredits),
										})}
									</li>
									<li className="gap-2.5 flex items-start">
										<CalendarClockIcon
											className="mt-0.5 size-4 shrink-0 text-[#bcaaff]"
											aria-hidden="true"
										/>
										{t("pricing.creditPackValidity", { months: pack.expiryMonths })}
									</li>
								</ul>
								<CreditPackCheckoutActions active={showingCreditPacks} packKey={pack.packKey} />
							</article>
						))}
					</div>
				</div>
			</div>
			{!showingCreditPacks && (
				<p className="mt-5 text-sm leading-6 text-center text-[#9f93aa]">
					{t("pricing.creditExpiry")}
				</p>
			)}
		</div>
	);
}

function CapabilityRail({ hasQualityAccess }: { hasQualityAccess: boolean }) {
	const t = useTranslations();
	const capabilities: Array<{
		icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
		label: string;
	}> = [
		{ icon: WandSparklesIcon, label: t("pricing.standardEdit") },
		...(hasQualityAccess ? [{ icon: SparklesIcon, label: t("pricing.qualityEdit") }] : []),
		{ icon: LockKeyholeIcon, label: t("pricing.privateAssets") },
		{ icon: HistoryIcon, label: t("pricing.editHistory") },
		{ icon: CropIcon, label: t("pricing.aspectRatios") },
	];

	return (
		<div className="mt-5" aria-label={t("pricing.capabilitiesLabel")}>
			<p className="font-bold text-[0.66rem] tracking-[0.12em] text-[#978b9f] uppercase">
				{t("pricing.capabilitiesLabel")}
			</p>
			<div className="mt-2 gap-1.5 flex flex-wrap">
				{capabilities.map(({ icon: Icon, label }) => (
					<span
						key={label}
						className="border-white/8 bg-black/15 gap-1.5 px-2 py-1.5 inline-flex items-center rounded-lg border text-[0.68rem] leading-none text-[#d9cfdf]"
					>
						<Icon className="size-3.5 shrink-0 text-[#bcaaff]" aria-hidden={true} />
						{label}
					</span>
				))}
			</div>
		</div>
	);
}

function PricingViewButton({
	active,
	children,
	controls,
	dataTest,
	onClick,
}: {
	active: boolean;
	children: ReactNode;
	controls: string;
	dataTest: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			aria-controls={controls}
			aria-pressed={active}
			data-test={dataTest}
			onClick={onClick}
			className={`min-h-11 gap-1 px-2 text-xs sm:gap-2 sm:px-5 sm:text-sm font-semibold focus-visible:outline-violet-200 inline-flex shrink-0 items-center rounded-full transition focus-visible:outline-2 focus-visible:outline-offset-2 ${
				active
					? "bg-[#f4efff] text-[#2d2140] shadow-[0_8px_22px_-14px_rgba(255,255,255,0.9)]"
					: "hover:bg-white/[0.055] hover:text-white text-[#afa4b7]"
			}`}
		>
			{children}
		</button>
	);
}

function formatCurrency(locale: string, amount: number, currency: string): string {
	const hasFraction = !Number.isInteger(amount);
	return new Intl.NumberFormat(locale, {
		style: "currency",
		currency,
		minimumFractionDigits: hasFraction ? 2 : 0,
		maximumFractionDigits: hasFraction ? 2 : 0,
	}).format(amount);
}

function formatNumber(locale: string, value: number): string {
	return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
}
