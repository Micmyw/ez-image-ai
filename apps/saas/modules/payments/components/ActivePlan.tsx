"use client";

import { usePlanData } from "@payments/hooks/plan-data";
import { usePurchases } from "@payments/hooks/purchases";
import { SettingsItem } from "@shared/components/SettingsItem";
import { BadgeCheckIcon, CheckIcon } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import { CancelSubscriptionButton } from "../../settings/components/CancelSubscriptionButton";
import { CustomerPortalButton } from "../../settings/components/CustomerPortalButton";
import { SubscriptionStatusBadge } from "../../settings/components/SubscriptionStatusBadge";

export function ActivePlan({ organizationId }: { organizationId?: string; seats?: number }) {
	const t = useTranslations();
	const { activePlan, activeSubscriptions, purchases } = usePurchases(organizationId);
	const plans = activeSubscriptions.length ? activeSubscriptions : activePlan ? [activePlan] : [];
	if (!plans.length) return null;
	return (
		<SettingsItem title={t("settings.billing.activePlan.title")}>
			{activeSubscriptions.length === 0 &&
				purchases.some((p) => p.subscription?.refundTermination === "COMPLETED") && (
					<output className="mb-4 text-sm block">
						{t("settings.billing.activePlan.refundTerminated")}
					</output>
				)}
			{activeSubscriptions.length > 1 && (
				<output className="mb-4 text-sm text-amber-700 block">
					{t("settings.billing.activePlan.multipleSubscriptions")}
				</output>
			)}
			<div className="gap-4 grid">
				{plans.map((plan) => (
					<ActivePlanCard
						key={"purchaseId" in plan ? plan.purchaseId : plan.id}
						activePlan={plan}
						organizationId={organizationId}
					/>
				))}
			</div>
		</SettingsItem>
	);
}

function ActivePlanCard({
	activePlan,
	organizationId,
}: {
	activePlan: NonNullable<ReturnType<typeof usePurchases>["activePlan"]>;
	organizationId?: string;
}) {
	const t = useTranslations();
	const format = useFormatter();
	const { planData } = usePlanData();

	const activePlanData = planData[activePlan.id as keyof typeof planData];

	if (!activePlanData) {
		return null;
	}

	const price = "price" in activePlan ? activePlan.price : null;
	const cancellationScheduled = activePlan.subscription?.cancelAtPeriodEnd === true;
	const periodEnd = activePlan.subscription?.currentPeriodEnd;
	const refundTermination = activePlan.subscription?.refundTermination;

	return (
		<div className="p-4 rounded-lg border">
			<div className="">
				<div className="gap-2 flex items-center">
					<BadgeCheckIcon className="size-6 text-primary" />
					<h4 className="font-bold text-lg text-primary">
						<span>{activePlanData.title}</span>
					</h4>
					{activePlan.status && !refundTermination && (
						<SubscriptionStatusBadge
							status={cancellationScheduled ? "canceling" : activePlan.status}
						/>
					)}
				</div>
				{"provider" in activePlan &&
					(activePlan.provider === "paypal" ||
						activePlan.provider === "waffo" ||
						activePlan.provider === "stripe") && (
						<p className="mt-2 text-sm text-muted-foreground">
							{t("settings.billing.activePlan.paymentMethod", {
								provider: t(`payments.providerSelector.providers.${activePlan.provider}`),
							})}
						</p>
					)}
				{"isEffectiveSubscription" in activePlan && activePlan.isEffectiveSubscription && (
					<p className="mt-1 text-sm text-muted-foreground">
						{t("settings.billing.activePlan.effectivePlan")}
					</p>
				)}
				{refundTermination && (
					<output className="mt-2 text-sm block">
						{t(
							refundTermination === "RETRYING"
								? "settings.billing.activePlan.refundTerminationRetrying"
								: "settings.billing.activePlan.refundTerminationPending",
						)}
					</output>
				)}
				{!refundTermination && !cancellationScheduled && periodEnd && (
					<p className="mt-2 text-sm text-muted-foreground">
						{t("settings.billing.activePlan.currentPeriodEnd", {
							date: format.dateTime(periodEnd, { dateStyle: "medium" }),
						})}
					</p>
				)}
				{!refundTermination && cancellationScheduled && periodEnd && (
					<p className="mt-2 text-sm text-muted-foreground">
						{t("settings.billing.activePlan.cancellationScheduled", {
							date: format.dateTime(periodEnd, { dateStyle: "medium" }),
						})}
					</p>
				)}

				{!refundTermination && !!activePlanData.features?.length && (
					<ul className="mt-2 gap-2 text-sm grid list-none">
						{activePlanData.features.map((feature, key) => (
							<li key={key} className="flex items-center justify-start">
								<CheckIcon className="mr-2 size-4 text-primary" />
								<span>{feature}</span>
							</li>
						))}
					</ul>
				)}

				{price && !refundTermination && (
					<strong
						className="mt-2 font-medium text-2xl lg:text-3xl block"
						data-test="price-table-plan-price"
					>
						{format.number(price.amount, {
							style: "currency",
							currency: price.currency,
						})}
						{"interval" in price && (
							<span className="font-normal text-xs opacity-60">
								{" / "}
								{price.interval === "month"
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
			</div>

			{!refundTermination && "purchaseId" in activePlan && activePlan.purchaseId && (
				<div className="mt-4 flex justify-end">
					<div className="gap-2 md:flex-row flex w-full flex-col flex-wrap">
						{activePlan.providerCapabilities.portal ? (
							<CustomerPortalButton purchaseId={activePlan.purchaseId} />
						) : activePlan.providerCapabilities.cancellation && !cancellationScheduled ? (
							<CancelSubscriptionButton
								purchaseId={activePlan.purchaseId}
								organizationId={organizationId}
							/>
						) : null}
					</div>
				</div>
			)}
		</div>
	);
}
