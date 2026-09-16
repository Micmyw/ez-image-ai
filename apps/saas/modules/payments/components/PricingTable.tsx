"use client";

import { usePlanData } from "@payments/hooks/plan-data";
import { usePaymentAction } from "@payments/hooks/use-payment-action";
import {
	calculateAnnualBillingPrice,
	calculateAnnualPlanPricing,
} from "@payments/lib/annual-plan-pricing";
import { upgradeHref, type UpgradeSelection } from "@payments/lib/upgrade-selection";
import type { PlanId } from "@payments/types";
import { PLAN_ENTITLEMENTS } from "@repo/config/client";
import { config as paymentsConfig } from "@repo/payments/config";
import type { PaidPlan } from "@repo/payments/types";
import { cn } from "@repo/ui";
import { Button } from "@repo/ui/components/button";
import { Tabs, TabsList, TabsTrigger } from "@repo/ui/components/tabs";
import { useLocaleCurrency } from "@shared/hooks/locale-currency";
import { useRouter } from "@shared/hooks/router";
import { saasGrowthFunnel } from "@shared/lib/growth-analytics";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowRightIcon, BadgePercentIcon, CheckIcon, StarIcon } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useRef, useState } from "react";

import {
	createCheckoutAttemptController,
	filterSubscriptionCheckoutProviders,
	isSubscriptionCheckoutProvider,
	type CheckoutSelection,
	type SubscriptionCheckoutProvider,
} from "./checkout-attempt";
import { PaymentProviderSelector } from "./PaymentProviderSelector";
import { PendingSubscriptionCheckout } from "./PendingSubscriptionCheckout";
import {
	SubscriptionCheckoutNotice,
	type SubscriptionCheckoutBlocker,
} from "./SubscriptionCheckoutNotice";

const plans = paymentsConfig.plans;

export function PricingTable({
	className,
	userId,
	organizationId,
	activePlanId,
	subscriptionBlocked = false,
	subscriptionBlockers = [],
	compact = false,
	initialSelection,
	accountLoading = false,
}: {
	className?: string;
	userId?: string;
	organizationId?: string;
	activePlanId?: string;
	subscriptionBlocked?: boolean;
	subscriptionBlockers?: SubscriptionCheckoutBlocker[];
	compact?: boolean;
	initialSelection?: UpgradeSelection;
	accountLoading?: boolean;
	returnTo?: string;
}) {
	const t = useTranslations();
	const format = useFormatter();
	const router = useRouter();
	const localeCurrency = useLocaleCurrency();
	const locale = useLocale();
	const payment = usePaymentAction();
	const loading = payment.action?.key.startsWith("plan:")
		? payment.action.key.split(":")[1]
		: false;
	const [interval, setInterval] = useState<"month" | "year">(initialSelection?.interval ?? "year");
	const [selectedPlan, setSelectedPlan] = useState<UpgradeSelection["planId"]>(
		initialSelection?.planId ?? "ultimate",
	);
	const [checkoutUnavailable, setCheckoutUnavailable] = useState(false);
	const [checkoutConflict, setCheckoutConflict] = useState<"subscription" | "pending" | null>(null);
	const hasSubscription = subscriptionBlocked || Boolean(activePlanId && activePlanId !== "free");
	const checkoutAttempts = useRef(createCheckoutAttemptController(createGrowthAttemptKey));

	const { planData } = usePlanData();
	const authenticated = Boolean(userId || organizationId);
	const pending = useQuery({
		...orpc.payments.getPendingSubscriptionCheckout.queryOptions({ input: {} }),
		enabled: authenticated && !hasSubscription,
	});
	const checkoutBlocked =
		accountLoading ||
		Boolean(payment.action) ||
		checkoutConflict === "subscription" ||
		(authenticated && (pending.isPending || pending.isError || Boolean(pending.data)));

	const createCheckoutLinkMutation = useMutation(
		orpc.payments.createCheckoutLink.mutationOptions(),
	);

	const onSelectPlan = async (
		planId: PlanId,
		interval: "month" | "year",
		provider: SubscriptionCheckoutProvider,
	) => {
		if (hasSubscription || checkoutBlocked) return;
		if (!(userId || organizationId)) {
			if (planId === "creator" || planId === "ultimate" || planId === "studio") {
				router.push(
					`/login?redirectTo=${encodeURIComponent(upgradeHref({ planId, interval }, locale))}`,
				);
			}
			return;
		}

		if (planId !== "creator" && planId !== "ultimate" && planId !== "studio") {
			setCheckoutUnavailable(true);
			return;
		}

		if (!payment.acquire(`plan:${planId}`)) return;
		setCheckoutConflict(null);
		setCheckoutUnavailable(false);
		const selection: CheckoutSelection = { provider, planId, interval };
		const checkoutAttemptKey = checkoutAttempts.current.begin(selection);

		try {
			const { checkoutLink } = await createCheckoutLinkMutation.mutateAsync({
				provider,
				planId,
				interval,
				idempotencyKey: checkoutAttemptKey,
			});

			void saasGrowthFunnel.checkoutStarted(checkoutAttemptKey, planId).catch(() => undefined);
			checkoutAttempts.current.succeeded(selection);
			payment.redirecting();
			window.location.href = checkoutLink;
		} catch (error) {
			const conflict = error instanceof Error && "code" in error && error.code === "CONFLICT";
			if (conflict)
				setCheckoutConflict(
					error.message === "PAYMENT_SUBSCRIPTION_ALREADY_EXISTS" ? "subscription" : "pending",
				);
			else setCheckoutUnavailable(true);
			if (conflict) await pending.refetch();
			payment.release();
		}
	};

	const filteredPlans = Object.entries(plans).filter(([planId]) => planId !== activePlanId);

	const hasSubscriptions = filteredPlans.some(([_, plan]) =>
		"prices" in plan
			? (plan as PaidPlan).prices.some((price) => price.type === "subscription")
			: false,
	);
	if (hasSubscription) {
		return <SubscriptionCheckoutNotice blockers={subscriptionBlockers} />;
	}
	const notices = (
		<>
			{authenticated && <PendingSubscriptionCheckout />}
			{checkoutConflict && (
				<p className="mb-4 text-sm text-destructive" role="alert">
					{t(
						checkoutConflict === "subscription"
							? "pricing.subscriptionAlreadyExists"
							: "pricing.checkoutAlreadyPending",
					)}
				</p>
			)}
			{(checkoutUnavailable || (authenticated && pending.isError)) && (
				<p className="mb-4 text-sm text-destructive" role="alert">
					{t("pricing.checkoutUnavailable")}
				</p>
			)}
		</>
	);
	if (compact) {
		const selectedPrice = PLAN_ENTITLEMENTS.find((plan) => plan.id === selectedPlan)!.prices.find(
			(price) => price.interval === interval,
		)!;
		return (
			<div className={className} data-test="upgrade-plan-picker">
				{notices}
				<fieldset
					disabled={Boolean(payment.action)}
					className="mb-5 border-white/10 bg-white/5 p-1 flex rounded-full border"
				>
					<legend className="sr-only">{t("pricing.upgrade.billingPeriod")}</legend>
					{(["month", "year"] as const).map((value) => (
						<button
							key={value}
							type="button"
							aria-pressed={interval === value}
							onClick={() => setInterval(value)}
							className={cn(
								"min-h-10 px-4 text-sm font-semibold flex-1 rounded-full transition disabled:cursor-wait",
								interval === value ? "bg-[#e7ddff] text-[#291d3d]" : "text-[#b8adbf]",
							)}
						>
							{t(value === "month" ? "pricing.monthly" : "pricing.yearly")}
						</button>
					))}
				</fieldset>
				<fieldset disabled={Boolean(payment.action)} className="gap-3 grid">
					<legend className="sr-only">{t("pricing.choosePlan")}</legend>
					{(["creator", "ultimate", "studio"] as const).map((planId) => {
						const plan = PLAN_ENTITLEMENTS.find((entry) => entry.id === planId)!;
						const price = plan.prices.find((entry) => entry.interval === interval)!;
						const annual = interval === "year" ? calculateAnnualBillingPrice(plan.prices) : null;
						const savings = interval === "year" ? calculateAnnualPlanPricing(plan.prices) : null;
						return (
							<label
								key={planId}
								className={cn(
									"studio-upgrade-plan-option min-h-28 gap-3 p-4 relative cursor-pointer items-center rounded-2xl border transition has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[#c6b1ff]",
									selectedPlan === planId
										? "border-[#b79cff] bg-[#b79cff]/10"
										: "border-white/10 bg-white/[0.025] hover:border-white/25",
									payment.action && "cursor-wait opacity-70",
								)}
							>
								<input
									type="radio"
									name="upgrade-plan"
									value={planId}
									checked={selectedPlan === planId}
									onChange={() => setSelectedPlan(planId)}
									className="size-5 shrink-0 accent-[#b79cff]"
								/>
								<span className="min-w-0 flex-1">
									<span className="text-lg font-semibold text-white block">
										{t(`pricing.products.${planId}.title`)}
									</span>
									<span className="mt-1 text-xs block text-[#c8b5f8]">
										{t("pricing.monthlyCredits", { credits: plan.monthlyCredits })}
									</span>
								</span>
								<span className="studio-upgrade-plan-price shrink-0 text-right">
									<span className="text-2xl font-semibold text-white">
										{format.number(annual?.monthlyEquivalent ?? price.amount, {
											style: "currency",
											currency: price.currency,
											maximumFractionDigits: 2,
										})}
									</span>
									<span className="text-xs text-[#b8adbf]">
										/{t("pricing.month", { count: 1 })}
									</span>
									{annual && (
										<span className="mt-1 text-xs block text-[#b8adbf]">
											{t("pricing.annualTotal", {
												total: format.number(annual.total, {
													style: "currency",
													currency: annual.currency,
													maximumFractionDigits: 0,
												}),
											})}
											{savings && (
												<span className="ml-2 text-[#c8b5f8]">−{savings.savingsPercent}%</span>
											)}
										</span>
									)}
								</span>
							</label>
						);
					})}
				</fieldset>
				<div className="studio-checkout-footer">
					<div
						className="gap-3 pt-3 text-sm flex items-center justify-between text-[#e7ddff]"
						data-test="checkout-selection"
					>
						<strong>{t(`pricing.products.${selectedPlan}.title`)}</strong>
						<span>
							{format.number(selectedPrice.amount, {
								style: "currency",
								currency: selectedPrice.currency,
								maximumFractionDigits: 2,
							})}
							/{t(interval === "year" ? "pricing.year" : "pricing.month", { count: 1 })}
						</span>
					</div>
					<CheckoutControls
						planId={selectedPlan}
						interval={interval}
						recommended
						authenticated={authenticated}
						loading={loading === selectedPlan}
						disabled={checkoutBlocked}
						onCheckout={(provider) => onSelectPlan(selectedPlan, interval, provider)}
						compact
					/>
					<output
						className="mt-3 text-xs leading-5 block text-center text-[#a99cb5]"
						aria-live="polite"
					>
						{payment.action
							? t(
									payment.action.stage === "redirecting"
										? "pricing.upgrade.redirectingHint"
										: "pricing.upgrade.processingHint",
								)
							: t("pricing.upgrade.secureHint")}
					</output>
				</div>
			</div>
		);
	}

	return (
		<div className={cn("@container", className)}>
			{(userId || organizationId) && <PendingSubscriptionCheckout />}
			{checkoutConflict && (
				<p className="mb-4 text-sm text-center text-destructive" role="alert">
					{t(
						checkoutConflict === "subscription"
							? "pricing.subscriptionAlreadyExists"
							: "pricing.checkoutAlreadyPending",
					)}
				</p>
			)}
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
							<TabsTrigger value="month" disabled={Boolean(payment.action)}>
								{t("pricing.monthly")}
							</TabsTrigger>
							<TabsTrigger value="year" disabled={Boolean(payment.action)}>
								{t("pricing.yearly")}
							</TabsTrigger>
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
									(planId === "creator" || planId === "ultimate" || planId === "studio") ? (
										<CheckoutControls
											planId={planId}
											interval={price.interval}
											recommended={recommended}
											authenticated={Boolean(userId || organizationId)}
											loading={loading === planId}
											disabled={checkoutBlocked}
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
	disabled,
	onCheckout,
	compact = false,
}: {
	planId: PlanId;
	interval: "month" | "year";
	recommended: boolean;
	authenticated: boolean;
	loading: boolean;
	disabled: boolean;
	onCheckout: (provider: SubscriptionCheckoutProvider) => void;
	compact?: boolean;
}) {
	const t = useTranslations();
	const payment = usePaymentAction();
	const [selectedProvider, setSelectedProvider] = useState<SubscriptionCheckoutProvider | null>(
		null,
	);
	const availability = useQuery({
		...orpc.payments.getProviderAvailability.queryOptions({ input: { planId, interval } }),
		staleTime: 30_000,
		refetchInterval: 30_000,
	});
	const providers = filterSubscriptionCheckoutProviders(
		availability.data?.providers
			.filter(({ capabilities }) => capabilities.checkout)
			.map(({ name }) => name) ?? [],
	);
	const provider =
		selectedProvider && providers.includes(selectedProvider)
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
					onValueChange={(nextProvider) => {
						if (isSubscriptionCheckoutProvider(nextProvider)) {
							setSelectedProvider(nextProvider);
						}
					}}
					disabled={disabled}
				/>
			)}
			{unavailable && (
				<p className="mt-3 text-sm text-destructive" role="alert">
					{t("payments.providerSelector.unavailable")}
				</p>
			)}
			<Button
				className={cn("mt-4 w-full", compact && "min-h-12 rounded-xl")}
				variant={recommended ? "primary" : "secondary"}
				onClick={() => provider && onCheckout(provider)}
				loading={loading || availability.isPending}
				disabled={disabled || !provider || unavailable}
				aria-busy={loading}
				data-test="subscription-checkout"
			>
				{loading
					? t(
							payment.action?.stage === "redirecting"
								? "pricing.upgrade.redirecting"
								: "pricing.upgrade.processing",
						)
					: compact
						? t(
								authenticated
									? "pricing.upgrade.continuePayment"
									: "pricing.upgrade.signInContinue",
							)
						: authenticated
							? t("pricing.choosePlan")
							: t("pricing.getStarted")}
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
