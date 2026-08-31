"use client";

import { Button } from "@repo/ui/components/button";
import { toastError, toastSuccess } from "@repo/ui/components/toast";
import { useConfirmationAlert } from "@shared/components/ConfirmationAlertProvider";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { XCircleIcon } from "lucide-react";
import { useTranslations } from "next-intl";

export function CancelSubscriptionButton({
	purchaseId,
	organizationId,
}: {
	purchaseId: string;
	organizationId?: string;
}) {
	const t = useTranslations("settings.billing.cancelSubscription");
	const { confirm } = useConfirmationAlert();
	const queryClient = useQueryClient();
	const cancelMutation = useMutation(orpc.payments.cancelPurchaseSubscription.mutationOptions());

	const confirmCancellation = () => {
		confirm({
			title: t("confirmation.title"),
			message: t("confirmation.description"),
			confirmLabel: t("confirmation.confirm"),
			destructive: true,
			onConfirm: async () => {
				try {
					await cancelMutation.mutateAsync({ purchaseId });
					await queryClient.invalidateQueries({
						queryKey: orpc.payments.listPurchases.queryKey({
							input: { organizationId },
						}),
					});
					toastSuccess(t("notifications.success"));
				} catch {
					toastError(t("notifications.error"));
				}
			},
		});
	};

	return (
		<Button
			variant="secondary"
			size="sm"
			onClick={confirmCancellation}
			loading={cancelMutation.isPending}
		>
			<XCircleIcon className="mr-2 size-4" />
			{t("label")}
		</Button>
	);
}
