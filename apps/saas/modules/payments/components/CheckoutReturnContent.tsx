"use client";

import { useSessionQuery } from "@auth/lib/api";
import type { PlanId } from "@payments/types";
import { Spinner } from "@repo/ui/components/spinner";
import { saasGrowthFunnel } from "@shared/lib/growth-analytics";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { consumeVideoEffectPaymentReturn } from "../../video-effects/lib/payment-return";
import { checkoutReturnDestination, createChoosePlanPath } from "../lib/editor-upgrade";

const MAX_WAIT_MS = 20_000;
const POLL_INTERVAL_MS = 2_000;

export function CheckoutReturnContent({
	organizationId,
	expectedPlanId,
	returnTo,
	checkoutIntentId,
	canceled = false,
}: {
	organizationId?: string;
	expectedPlanId: PlanId;
	returnTo: string;
	checkoutIntentId?: string;
	canceled?: boolean;
}) {
	const t = useTranslations("checkoutReturn");
	const router = useRouter();
	const session = useSessionQuery();
	const [polling, setPolling] = useState(true);
	const { mutateAsync: refreshCheckout } = useMutation(
		orpc.payments.refreshPendingSubscriptionCheckout.mutationOptions(),
	);
	useEffect(() => {
		if (checkoutIntentId) void refreshCheckout({ checkoutIntentId }).catch(() => undefined);
		if (canceled) router.replace(createChoosePlanPath(returnTo));
	}, [checkoutIntentId, canceled, refreshCheckout, returnTo, router]);

	const { data } = useQuery({
		...orpc.payments.getCheckoutReturnState.queryOptions({
			input: { organizationId, expectedPlanId },
		}),
		refetchInterval: polling ? POLL_INTERVAL_MS : false,
	});

	useEffect(() => {
		if (session.isPending) return;
		const destination = checkoutReturnDestination(data?.status, returnTo);
		if (destination) {
			void saasGrowthFunnel.subscriptionActivated(expectedPlanId);
			setPolling(false);
			router.replace(
				consumeVideoEffectPaymentReturn(session.data?.user?.id, checkoutIntentId) ?? destination,
			);
		}
	}, [
		data?.status,
		expectedPlanId,
		returnTo,
		router,
		session.data?.user?.id,
		session.isPending,
		checkoutIntentId,
	]);

	useEffect(() => {
		if (!polling) return;
		const timer = setTimeout(() => {
			setPolling(false);
			router.replace(createChoosePlanPath(returnTo));
		}, MAX_WAIT_MS);

		return () => clearTimeout(timer);
	}, [polling, returnTo, router]);

	return (
		<div className="gap-4 py-8 flex flex-col items-center justify-center">
			<Spinner className="size-8" />
			<p className="text-sm text-center text-muted-foreground">{t("loading")}</p>
		</div>
	);
}
