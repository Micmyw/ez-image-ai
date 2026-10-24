import {
	FREE_ACCOUNT_SIGN_IN_CREDITS,
	getPlanUsageEstimate,
	PLAN_ENTITLEMENTS,
} from "@repo/config/client";
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
		let technicalFeatures: ReactNode[] = [];
		if (entitlement) {
			const usage = getPlanUsageEstimate(entitlement.id);
			technicalFeatures = [
				entitlement.id === "free"
					? t("pricing.welcomeCredits", { credits: FREE_ACCOUNT_SIGN_IN_CREDITS })
					: t("pricing.monthlyCredits", { credits: entitlement.monthlyCredits }),
				entitlement.id === "free"
					? t("pricing.welcomeImageAllowance", {
							count: Math.floor(FREE_ACCOUNT_SIGN_IN_CREDITS / usage.minimumCreditsPerImage),
							credits: usage.minimumCreditsPerImage,
						})
					: usage.minimumImageEdits === usage.maximumImageEdits
						? t("pricing.monthlyFixedImageAllowance", {
								count: usage.maximumImageEdits,
								credits: usage.minimumCreditsPerImage,
							})
						: t("pricing.monthlyImageAllowance", {
								minimum: usage.minimumImageEdits,
								maximum: usage.maximumImageEdits,
								minimumCredits: usage.minimumCreditsPerImage,
								maximumCredits: usage.maximumCreditsPerImage,
							}),
				t(entitlement.id === "free" ? "pricing.welcomeCreditExpiry" : "pricing.creditExpiry"),
				t("pricing.maximumInputSize", {
					megabytes: Math.round(entitlement.maximumInputBytes / 1024 / 1024),
				}),
			];
		}
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
