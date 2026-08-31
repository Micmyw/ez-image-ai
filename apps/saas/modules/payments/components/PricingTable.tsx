"use client";

import { usePlanData } from "@payments/hooks/plan-data";
import type { PlanId } from "@payments/types";
import { config as paymentsConfig } from "@repo/payments/config";
import type { PaidPlan, PaymentProviderName } from "@repo/payments/types";
import { cn } from "@repo/ui";
import { Button } from "@repo/ui/components/button";
import { Tabs, TabsList, TabsTrigger } from "@repo/ui/components/tabs";
import { useLocaleCurrency } from "@shared/hooks/locale-currency";
import { useRouter } from "@shared/hooks/router";
import { saasGrowthFunnel } from "@shared/lib/growth-analytics";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowRightIcon, BadgePercentIcon, CheckIcon, StarIcon } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

import { PaymentProviderSelector } from "./PaymentProviderSelector";

const plans = paymentsConfig.plans;

export function PricingTable({
	className,
	userId,
	organizationId,
	activePlanId,
}: {
	className?: string;
	userId?: string;
	organizationId?: string;
	activePlanId?: string;
	returnTo?: string;
}) {
	const t = useTranslations();
	const format = useFormatter();
	const router = useRouter();
	const localeCurrency = useLocaleCurrency();
	const [loading, setLoading] = useState<PlanId | false>(false);
	const [interval, setInterval] = useState<"month" | "year">("month");
	const [checkoutUnavailable, setCheckoutUnavailable] = useState(false);

	const { planData } = usePlanData();

	const createCheckoutLinkMutation = useMutation(
		orpc.payments.createCheckoutLink.mutationOptions(),
	);

	const onSelectPlan = async (
		planId: PlanId,
		interval: "month" | "year",
		provider: PaymentProviderName,
	) => {
		if (!(userId || organizationId)) {
			router.push("/signup");
			return;
		}

		if (planId !== "creator" && planId !== "studio") {
			setCheckoutUnavailable(true);
			return;
		}

		setLoading(planId);
		setCheckoutUnavailable(false);
		const checkoutAttemptKey = createGrowthAttemptKey();

		try {
			const { checkoutLink } = await createCheckoutLinkMutation.mutateAsync({
				provider,
				planId,
				interval,
				idempotencyKey: checkoutAttemptKey,
			});

			await saasGrowthFunnel.checkoutStarted(checkoutAttemptKey, planId);
			window.location.href = checkoutLink;
		} catch {
			setCheckoutUnavailable(true);
		} finally {
			setLoading(false);
		}
	};

	const filteredPlans = Object.entries(plans).filter(([planId]) => planId !== activePlanId);

	const hasSubscriptions = filteredPlans.some(([_, plan]) =>
		"prices" in plan
			? (plan as PaidPlan).prices.some((price) => price.type === "subscription")
			: false,
	);

	return (
		<div className={cn("@container", className)}>
			{checkoutUnavailable && (
				<p className="mb-4 text-sm text-center text-destructive" role="alert">
					{t("pricing.checkoutUnavailable")}
				</p>
			)}
			{hasSubscriptions && (
				<div className="mb-6 flex justify-center">
					<Tabs
						value={interval}
						onValueChange={(value) => setInterval(value as typeof interval)}
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
				className={cn("gap-4 grid grid-cols-1", {
					"@xl:grid-cols-2": filteredPlans.length >= 2,
					"@3xl:grid-cols-3": filteredPlans.length >= 3,
					"@4xl:grid-cols-4": filteredPlans.length >= 4,
				})}
			>
				{filteredPlans.map(([planId, plan]) => {
					const isEnterprise = "isEnterprise" in plan ? plan.isEnterprise : false;
					const prices = "prices" in plan ? (plan as PaidPlan).prices : undefined;
					const recommended = plan.recommended ?? false;
					const hidden = plan.hidden ?? false;

					const planDataEntry = planData[planId as keyof typeof planData];

					if (!planDataEntry) {
						return null;
					}

					const { title, description, features } = planDataEntry;

					const price = prices?.find(
						(price) =>
							!hidden &&
							(price.type === "one-time" || price.interval === interval) &&
							price.currency === localeCurrency,
					);

					if (!price && !isEnterprise) {
						return null;
					}

					return (
						<div
							key={planId}
							className={cn("p-6 rounded-3xl border bg-card", {
								"border-primary": recommended,
							})}
							data-test="price-table-plan"
						>
							<div className="gap-4 flex h-full flex-col justify-between">
								<div>
									{recommended && (
										<div className="-mt-9 flex justify-center">
											<div className="mb-2 h-6 gap-1.5 px-2 py-1 font-semibold text-xs flex w-auto items-center rounded-full bg-primary text-primary-foreground">
												<StarIcon className="size-3" />
												{t("pricing.recommended")}
											</div>
										</div>
									)}
									<h3
										className={cn("my-0 font-semibold text-2xl", {
											"font-bold text-primary": recommended,
										})}
									>
										{title}
									</h3>
									{description && (
										<div className="prose mt-2 text-sm text-foreground/60">{description}</div>
									)}

									{!!features?.length && (
										<ul className="mt-4 gap-2 text-sm grid list-none">
											{features.map((feature, key) => (
												<li key={key} className="flex items-center justify-start">
													<CheckIcon className="mr-2 size-4 text-primary" />
													<span>{feature}</span>
												</li>
											))}
										</ul>
									)}

									{price && "trialPeriodDays" in price && price.trialPeriodDays && (
										<div className="mt-4 font-medium text-sm flex items-center justify-start text-primary opacity-80">
											<BadgePercentIcon className="mr-2 size-4" />
											{t("pricing.trialPeriod", {
												days: price.trialPeriodDays,
											})}
										</div>
									)}
								</div>

								<div>
									{price && (
										<strong
											className="font-medium text-2xl lg:text-3xl block"
											data-test="price-table-plan-price"
										>
											{format.number(price.amount, {
												style: "currency",
												currency: price.currency,
											})}
											{"interval" in price && (
												<span className="font-normal text-xs opacity-60">
													{" / "}
													{interval === "month"
														? t("pricing.month", {
																count: 1,
															})
														: t("pricing.year", {
																count: 1,
															})}
												</span>
											)}
											{organizationId && "seatBased" in price && price.seatBased && (
												<span className="font-normal text-xs opacity-60">
													{" / "}
													{t("pricing.perSeat")}
												</span>
											)}
										</strong>
									)}

									{price?.type === "subscription" &&
									(planId === "creator" || planId === "studio") ? (
										<CheckoutControls
											planId={planId}
											interval={price.interval}
											recommended={recommended}
											authenticated={Boolean(userId || organizationId)}
											loading={loading === planId}
											onCheckout={(provider) => onSelectPlan(planId, price.interval, provider)}
										/>
									) : (
										<Button
											className="mt-4 w-full"
											variant={recommended ? "primary" : "secondary"}
											onClick={() => setCheckoutUnavailable(true)}
										>
											{userId || organizationId ? t("pricing.choosePlan") : t("pricing.getStarted")}
											<ArrowRightIcon className="ml-2 size-4" />
										</Button>
									)}
								</div>
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}

function CheckoutControls({
	planId,
	interval,
	recommended,
	authenticated,
	loading,
	onCheckout,
}: {
	planId: "creator" | "studio";
	interval: "month" | "year";
	recommended: boolean;
	authenticated: boolean;
	loading: boolean;
	onCheckout: (provider: PaymentProviderName) => void;
}) {
	const t = useTranslations();
	const [selectedProvider, setSelectedProvider] = useState<PaymentProviderName | null>(null);
	const availability = useQuery(
		orpc.payments.getProviderAvailability.queryOptions({ input: { planId, interval } }),
	);
	const providers =
		availability.data?.providers
			.filter(({ capabilities }) => capabilities.checkout)
			.map(({ name }) => name) ?? [];
	const provider = providers.includes(selectedProvider as PaymentProviderName)
		? selectedProvider
		: (providers[0] ?? null);
	const unavailable = availability.isError || (!availability.isPending && providers.length === 0);

	return (
		<>
			{providers.length > 0 && (
				<PaymentProviderSelector
					name={`${planId}-${interval}-provider`}
					providers={providers}
					value={provider}
					onValueChange={setSelectedProvider}
					disabled={loading}
				/>
			)}
			{unavailable && (
				<p className="mt-3 text-sm text-destructive" role="alert">
					{t("payments.providerSelector.unavailable")}
				</p>
			)}
			<Button
				className="mt-4 w-full"
				variant={recommended ? "primary" : "secondary"}
				onClick={() => provider && onCheckout(provider)}
				loading={loading || availability.isPending}
				disabled={!provider || unavailable}
			>
				{authenticated ? t("pricing.choosePlan") : t("pricing.getStarted")}
				<ArrowRightIcon className="ml-2 size-4" />
			</Button>
		</>
	);
}

function createGrowthAttemptKey(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
