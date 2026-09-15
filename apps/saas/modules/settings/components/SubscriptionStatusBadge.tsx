"use client";

import type { BadgeProps } from "@repo/ui/components/badge";
import { Badge } from "@repo/ui/components/badge";
import { useTranslations } from "next-intl";

export function SubscriptionStatusBadge({ status }: { status: string; className?: string }) {
	const t = useTranslations();

	const badgeLabels: Record<string, string> = {
		pending: t("settings.billing.activePlan.status.pending"),
		active: t("settings.billing.activePlan.status.active"),
		canceling: t("settings.billing.activePlan.status.canceling"),
		cancellation_pending: t("settings.billing.activePlan.status.cancellationPending"),
		canceled: t("settings.billing.activePlan.status.canceled"),
		expired: t("settings.billing.activePlan.status.expired"),
		incomplete: t("settings.billing.activePlan.status.incomplete"),
		past_due: t("settings.billing.activePlan.status.past_due"),
		paused: t("settings.billing.activePlan.status.paused"),
		trialing: t("settings.billing.activePlan.status.trialing"),
		unpaid: t("settings.billing.activePlan.status.unpaid"),
	};

	const badgeColors: Record<string, BadgeProps["status"]> = {
		pending: "warning",
		active: "success",
		canceling: "warning",
		cancellation_pending: "warning",
		canceled: "error",
		expired: "error",
		incomplete: "warning",
		past_due: "warning",
		paused: "warning",
		trialing: "info",
		unpaid: "error",
	};

	return <Badge status={badgeColors[status]}>{badgeLabels[status]}</Badge>;
}
