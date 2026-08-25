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
	const buildPlanDataEntry = (planId: string): PlanDataEntry => {
		const entitlement = PLAN_ENTITLEMENTS.find((plan) => plan.id === planId);
		const technicalFeatures = entitlement
			? [
					t("pricing.monthlyCredits", { credits: entitlement.monthlyCredits }),
					t("pricing.concurrentEdits", { count: entitlement.maximumConcurrentJobs }),
					t("pricing.maximumInputSize", {
						megabytes: Math.round(entitlement.maximumInputBytes / 1024 / 1024),
					}),
				]
			: [];
		return {
			title: t(`pricing.products.${planId}.title`),
			description: t(`pricing.products.${planId}.description`),
			features: [
				...technicalFeatures,
				...Object.values(
					(t.raw(`pricing.products.${planId}.features`) as Record<string, string>) ?? {},
				),
			],
		};
	};

	for (const planId of Object.keys(config.plans)) {
		planData[planId] = buildPlanDataEntry(planId);
	}

	if (!config.requireActiveSubscription) {
		planData.free = buildPlanDataEntry("free");
	}

	return { planData };
}
