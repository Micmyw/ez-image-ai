"use client";

import { config } from "@config";
import {
	type MarketingCheckoutAvailability,
	unavailableMarketingCheckout,
} from "@home/lib/pricing";
import { LocaleLink } from "@i18n/routing";
import { getPlanUsageEstimate, getPublicConfig, PLAN_ENTITLEMENTS } from "@repo/config/client";
import { cn } from "@repo/ui";
import { Button } from "@repo/ui/components/button";
import { Tabs, TabsList, TabsTrigger } from "@repo/ui/components/tabs";
import { ArrowRightIcon, BadgePercentIcon, CheckIcon, StarIcon } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useMemo, useState } from "react";

const publicProductConfig = getPublicConfig();

export type { MarketingCheckoutAvailability } from "@home/lib/pricing";

export function isMarketingCheckoutAvailable(
	planId: string,
	interval: "month" | "year",
	availability: MarketingCheckoutAvailability,
): boolean {
	return (planId === "creator" || planId === "studio") && availability[planId][interval];
}

export function PricingSection({
	checkoutAvailability = unavailableMarketingCheckout,
	showHeading = true,
}: {
	checkoutAvailability?: MarketingCheckoutAvailability;
	showHeading?: boolean;
}) {
	const t = useTranslations();
	const format = useFormatter();
	const [interval, setBillingInterval] = useState<"month" | "year">("month");

	const signupUrl = useMemo(
		() => config.saasUrl && `${String(config.saasUrl).replace(/\/$/, "")}/signup`,
		[],
	);

	const plans = useMemo(() => {
		const result: Array<{
			id: string;
			title: string;
			description: string;
			features: string[];
			cta: string;
			recommended?: boolean;
			isEnterprise?: boolean;
			prices?: Array<{
				type: "subscription";
				interval: "month" | "year";
				amount: number;
				currency: string;
				trialPeriodDays?: number;
			}>;
			to: string;
		}> = [];
		const entitlementFeatures = (entitlement: (typeof PLAN_ENTITLEMENTS)[number]) => {
			const usage = getPlanUsageEstimate(entitlement.id);
			return [
				t("pricing.monthlyCredits", { credits: entitlement.monthlyCredits }),
				usage.qualityEdits === null
					? t("pricing.monthlyStandardAllowance", { standard: usage.standardEdits })
					: t("pricing.monthlyEditAllowance", {
							standard: usage.standardEdits,
							quality: usage.qualityEdits,
						}),
				t("pricing.creditExpiry"),
				t("pricing.concurrentEdits", { count: entitlement.maximumConcurrentJobs }),
				t("pricing.maximumInputSize", {
					megabytes: Math.round(
						Math.min(entitlement.maximumInputBytes, publicProductConfig.uploadLimits.imageBytes) /
							1024 /
							1024,
					),
				}),
			];
		};

		{
			const entitlement = PLAN_ENTITLEMENTS.find((item) => item.id === "free");
			result.push({
				id: "free",
				title: t("pricing.products.free.title") ?? "",
				description: t("pricing.products.free.description") ?? "",
				features: [
					...(entitlement ? entitlementFeatures(entitlement) : []),
					...Object.values(
						(t.raw("pricing.products.free.features") as Record<string, string>) ?? {},
					),
				],
				cta: t("pricing.getStarted") ?? "",
				to: signupUrl ?? "#",
			});
		}

		for (const entitlement of PLAN_ENTITLEMENTS.filter(({ id }) => id !== "free")) {
			const planId = entitlement.id;
			const prices = entitlement.prices.map((price) => ({
				type: "subscription" as const,
				...price,
			}));

			result.push({
				id: planId,
				title: t(`pricing.products.${planId}.title`) ?? "",
				description: t(`pricing.products.${planId}.description`) ?? "",
				features: [
					...entitlementFeatures(entitlement),
					...Object.values(
						(t.raw(`pricing.products.${planId}.features`) as Record<string, string>) ?? {},
					),
				],
				cta: t("pricing.getStarted") ?? "",
				recommended: planId === "creator",
				isEnterprise: false,
				prices,
				to: signupUrl ?? "#",
			});
		}

		return result;
	}, [t, signupUrl]);

	const hasSubscriptions = plans.some((p) =>
		p.prices?.some((price) => price.type === "subscription"),
	);

	return (
		<section
			id="pricing"
			className="scroll-mt-24 border-slate-200 bg-slate-50 py-14 sm:py-20 border-y"
		>
			<div className="container">
				{showHeading && (
					<div className="mb-8 max-w-3xl mx-auto text-center">
						<h2 className="text-3xl leading-tight font-semibold text-slate-950 sm:text-4xl lg:text-5xl tracking-[-0.035em]">
							{t("pricing.title")}
						</h2>
						<p className="mt-4 text-base leading-7 text-slate-600 sm:text-lg">
							{t("pricing.description")}
						</p>
					</div>
				)}

				<div className="@container">
					{hasSubscriptions && (
						<div className="mb-8 flex justify-center">
							<Tabs
								value={interval}
								onValueChange={(value) => setBillingInterval(value as "month" | "year")}
								data-test="price-table-interval-tabs"
							>
								<TabsList className="border-foreground/10">
									<TabsTrigger value="month">{t("pricing.monthly")}</TabsTrigger>
									<TabsTrigger value="year">{t("pricing.yearly")}</TabsTrigger>
								</TabsList>
							</Tabs>
						</div>
					)}
					<div
						className={cn(
							"gap-4 grid grid-cols-1",
							plans.length >= 2 && "@xl:grid-cols-2",
							plans.length >= 3 && "@3xl:grid-cols-3",
							plans.length >= 4 && "@4xl:grid-cols-4",
						)}
					>
						{plans.map((plan) => {
							const isFree = !plan.prices && !plan.isEnterprise;
							const price = isFree
								? undefined
								: plan.prices?.find((price) => price.interval === interval);
							const isPaidCheckoutUnavailable =
								!isFree &&
								!plan.isEnterprise &&
								(!price || !isMarketingCheckoutAvailable(plan.id, interval, checkoutAvailability));
							const trialPeriodDays = price?.trialPeriodDays;

							return (
								<div
									key={plan.id}
									className={cn(
										"p-6 relative rounded-3xl border bg-card",
										plan.recommended ? "border-primary" : "border-primary/20",
									)}
									data-test="price-table-plan"
								>
									{plan.recommended && (
										<div className="-top-3 px-2 py-1 font-semibold text-xs absolute left-1/2 flex -translate-x-1/2 items-center justify-center rounded-full bg-primary text-center text-primary-foreground">
											<StarIcon className="mr-1.5 size-3 inline-block" />
											{t("pricing.recommended")}
										</div>
									)}
									<div className="gap-4 flex h-full flex-col justify-between">
										<div>
											<h3 className="my-0 font-semibold text-2xl">{plan.title}</h3>
											{plan.description && (
												<div className="prose mt-2 text-sm text-foreground/60">
													{plan.description}
												</div>
											)}

											{!!plan.features?.length && (
												<ul className="mt-4 gap-2 text-sm grid list-none">
													{plan.features.map((feature, key) => (
														<li key={key} className="flex items-center justify-start">
															<CheckIcon className="mr-2 size-4 text-primary" />
															<span>{feature}</span>
														</li>
													))}
												</ul>
											)}

											{trialPeriodDays !== undefined && trialPeriodDays > 0 && (
												<div className="mt-4 font-medium text-sm flex items-center justify-start text-primary opacity-80">
													<BadgePercentIcon className="mr-2 size-4" />
													{t("pricing.trialPeriod", {
														days: trialPeriodDays,
													})}
												</div>
											)}
										</div>

										<div>
											{isFree && (
												<strong
													className="font-medium text-2xl lg:text-3xl block"
													data-test="price-table-plan-price"
												>
													{format.number(0, {
														style: "currency",
														currency: "USD",
													})}
												</strong>
											)}

											{price && (
												<strong
													className="font-medium text-2xl lg:text-3xl block"
													data-test="price-table-plan-price"
												>
													{format.number(price.amount, {
														style: "currency",
														currency: price.currency,
													})}
													{price.type === "subscription" && (
														<span className="font-normal text-xs opacity-60">
															/
															{price.interval === "year"
																? t("pricing.year", {
																		count: 1,
																	})
																: t("pricing.month", {
																		count: 1,
																	})}
														</span>
													)}
												</strong>
											)}

											{isPaidCheckoutUnavailable ? (
												<>
													<Button
														className="mt-4 w-full"
														variant={plan.recommended ? "primary" : "secondary"}
														disabled
														aria-disabled="true"
														aria-describedby={`pricing-${plan.id}-unavailable`}
													>
														{plan.cta}
													</Button>
													<p
														id={`pricing-${plan.id}-unavailable`}
														className="mt-2 text-sm text-destructive"
													>
														{t("pricing.checkoutUnavailable")}
													</p>
												</>
											) : plan.to.startsWith("/") ? (
												<Button
													className="mt-4 w-full"
													variant={plan.recommended ? "primary" : "secondary"}
													render={(props) => (
														<LocaleLink {...props} href={plan.to}>
															{plan.cta}
															<ArrowRightIcon className="ml-2 size-4" />
														</LocaleLink>
													)}
												/>
											) : (
												<Button
													className="mt-4 w-full"
													variant={plan.recommended ? "primary" : "secondary"}
													render={(props) => (
														<a {...props} href={plan.to}>
															{plan.cta}
															<ArrowRightIcon className="ml-2 size-4" />
														</a>
													)}
												/>
											)}
										</div>
									</div>
								</div>
							);
						})}
					</div>
				</div>
			</div>
		</section>
	);
}
