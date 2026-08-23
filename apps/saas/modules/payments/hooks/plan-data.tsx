import { PLAN_ENTITLEMENTS } from "@repo/config/client";
import { config } from "@repo/payments/config";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

type PlanDataEntry = {
	title: string;
	description: ReactNode;
	features: ReactNode[];
};

export function usePlanData() {
	const t = useTranslations();

	const planData: Record<string, PlanDataEntry> = {};

	for (const planId of Object.keys(config.plans)) {
		const entitlement = PLAN_ENTITLEMENTS.find((plan) => plan.id === planId);
		const technicalFeatures = entitlement
			? [
					`${entitlement.monthlyCredits.toLocaleString()} credits per month`,
					`${entitlement.maximumConcurrentJobs} concurrent jobs`,
					`${Math.round(entitlement.maximumInputBytes / 1024 / 1024)} MB input storage`,
				]
			: [];
		planData[planId] = {
			title: t(`pricing.products.${planId}.title`),
			description: t(`pricing.products.${planId}.description`),
			features: [
				...technicalFeatures,
				...Object.values(
					(t.raw(`pricing.products.${planId}.features`) as Record<string, string>) ?? {},
				),
			],
		};
	}

	if (!config.requireActiveSubscription) {
		planData.free = {
			title: t("pricing.products.free.title"),
			description: t("pricing.products.free.description"),
			features: Object.values(
				(t.raw("pricing.products.free.features") as Record<string, string>) ?? {},
			),
		};
	}

	return { planData };
}
