"use client";

import type { ResolvedPurchase } from "@repo/payments/lib/helper";
import { useFormatter, useTranslations } from "next-intl";

export type SubscriptionCheckoutBlocker = {
	provider: string;
	subscription: ResolvedPurchase["subscription"];
};

export function SubscriptionCheckoutNotice({
	blockers,
}: {
	blockers: SubscriptionCheckoutBlocker[];
}) {
	const t = useTranslations();
	const format = useFormatter();
	if (!blockers.length)
		return (
			<output className="text-sm block text-muted-foreground">
				{t("pricing.subscriptionAlreadyExists")}
			</output>
		);
	return (
		<output className="text-sm gap-2 grid text-muted-foreground">
			{blockers.map((blocker, index) => {
				const subscription = blocker.subscription;
				const provider = ["paypal", "waffo", "stripe"].includes(blocker.provider)
					? t(`payments.providerSelector.providers.${blocker.provider}`)
					: t("pricing.currentPaymentMethod");
				const cancellation = subscription?.cancellation;
				const periodEnd = subscription?.currentPeriodEnd;
				const key = subscription?.refundTermination
					? "pricing.subscriptionRefundPending"
					: cancellation === "CONFIRMED" && periodEnd
						? "pricing.subscriptionPaidThrough"
						: cancellation === "PENDING" ||
							  cancellation === "RETRYING" ||
							  subscription?.cancelAtPeriodEnd
							? "pricing.subscriptionCancellationPending"
							: "pricing.subscriptionRenewalOpen";
				return (
					<p key={index}>
						{t(key, {
							provider,
							date: periodEnd ? format.dateTime(periodEnd, { dateStyle: "medium" }) : "",
						})}
					</p>
				);
			})}
		</output>
	);
}
