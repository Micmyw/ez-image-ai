"use client";
import { PricingTable } from "@payments/components/PricingTable";
import { usePurchases } from "@payments/hooks/purchases";
import { SettingsItem } from "@shared/components/SettingsItem";
import { useTranslations } from "next-intl";

export function ChangePlan({
	organizationId,
	userId,
	activePlanId,
}: {
	organizationId?: string;
	userId?: string;
	activePlanId?: string;
}) {
	const t = useTranslations();
	const { activePlan, activeSubscriptions, hasBlockingSubscription } = usePurchases(organizationId);

	return (
		<SettingsItem
			title={t("settings.billing.changePlan.title")}
			description={t("settings.billing.changePlan.description")}
		>
			<PricingTable
				organizationId={organizationId}
				userId={userId}
				activePlanId={activePlan?.id ?? activePlanId}
				subscriptionBlocked={hasBlockingSubscription}
				subscriptionBlockers={activeSubscriptions}
			/>
		</SettingsItem>
	);
}
