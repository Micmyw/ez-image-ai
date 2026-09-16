"use client";

import { Button } from "@repo/ui/components/button";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";

import { usePaymentAction } from "../hooks/use-payment-action";

export function PendingSubscriptionCheckout() {
	const t = useTranslations("pricing.pendingCheckout");
	const queryClient = useQueryClient();
	const checking = useRef(false);
	const payment = usePaymentAction();
	const pending = useQuery(
		orpc.payments.getPendingSubscriptionCheckout.queryOptions({ input: {} }),
	);
	const refresh = useMutation(orpc.payments.refreshPendingSubscriptionCheckout.mutationOptions());
	const [status, setStatus] = useState<"PENDING" | "PAID" | "CLOSED" | "UNKNOWN" | null>(null);
	if (!pending.data) return null;
	return (
		<section className="mb-4 p-4 text-sm rounded-lg border" aria-label={t("title")}>
			<p className="font-medium">{t("title")}</p>
			<p className="mt-1 text-muted-foreground">
				{t("description", { provider: pending.data.provider === "paypal" ? "PayPal" : "Waffo" })}
			</p>
			<div className="mt-3 gap-2 flex flex-wrap">
				{pending.data.checkoutLink && (
					<Button
						size="sm"
						disabled={Boolean(payment.action) || refresh.isPending}
						loading={payment.action?.key === "resume-subscription"}
						render={(props) => (
							<a
								{...props}
								href={pending.data!.checkoutLink!}
								aria-disabled={Boolean(payment.action) || refresh.isPending}
								onClick={(event) => {
									if (checking.current || !payment.acquire("resume-subscription")) {
										event.preventDefault();
										return;
									}
									payment.redirecting();
								}}
							>
								{props.children}
							</a>
						)}
					>
						{t("resume")}
					</Button>
				)}
				<Button
					size="sm"
					variant="outline"
					disabled={refresh.isPending || Boolean(payment.action)}
					loading={refresh.isPending}
					aria-busy={refresh.isPending}
					onClick={async () => {
						if (checking.current || payment.action) return;
						checking.current = true;
						try {
							const result = await refresh.mutateAsync({ checkoutIntentId: pending.data!.id });
							setStatus(result.status);
							await queryClient.invalidateQueries({ queryKey: orpc.payments.key() });
						} catch {
							setStatus("UNKNOWN");
						} finally {
							checking.current = false;
						}
					}}
				>
					{t("refresh")}
				</Button>
			</div>
			{status && (
				<output className="mt-2 block text-muted-foreground" aria-live="polite">
					{t(status)}
				</output>
			)}
		</section>
	);
}
