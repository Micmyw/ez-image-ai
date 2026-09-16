"use client";

import { config } from "@config";
import { cn } from "@repo/ui";
import { Button } from "@repo/ui/components/button";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";

import { usePaymentAction } from "../hooks/use-payment-action";

export function PendingSubscriptionCheckout({ compact = false }: { compact?: boolean }) {
	const t = useTranslations("pricing.pendingCheckout");
	const pricing = useTranslations("pricing");
	const queryClient = useQueryClient();
	const checking = useRef(false);
	const payment = usePaymentAction();
	const pending = useQuery(
		orpc.payments.getPendingSubscriptionCheckout.queryOptions({ input: {} }),
	);
	const refresh = useMutation(orpc.payments.refreshPendingSubscriptionCheckout.mutationOptions());
	const [result, setResult] = useState<{
		id: string;
		status: "PENDING" | "PAID" | "CLOSED" | "UNKNOWN";
	} | null>(null);
	if (!pending.data) return null;
	const checkout = pending.data;
	const status = result?.id === checkout.id ? result.status : null;
	const provider = checkout.provider === "paypal" ? "PayPal" : "Waffo";
	const plan =
		checkout.planId && ["creator", "ultimate", "studio"].includes(checkout.planId)
			? pricing(`products.${checkout.planId}.title`)
			: pricing("choosePlan");
	const period = checkout.interval === "year" ? pricing("yearly") : pricing("monthly");
	const supportHref = config.supportEmail
		? `mailto:${config.supportEmail}?subject=${encodeURIComponent(t("supportSubject", { id: checkout.id }))}&body=${encodeURIComponent(`${t("order", { id: checkout.id })}\n${plan} · ${period} · ${provider}`)}`
		: "/contact";
	const details = (
		<>
			<p className="mt-1 text-muted-foreground">{t("description", { provider })}</p>
			<p className="mt-2 font-medium">{t("chargedHint")}</p>
			<p className="mt-2 break-all select-text" data-test="pending-checkout-reference">
				{t("order", { id: checkout.id })}
			</p>
		</>
	);
	return (
		<section
			className={cn("pending-checkout p-3 text-sm rounded-xl border", compact ? "mt-3" : "mb-4")}
			aria-label={t("title")}
		>
			<p className="font-medium">{t("title")}</p>
			<p className="mt-1 text-xs text-muted-foreground">
				{plan} · {period} · {provider}
			</p>
			{!compact && details}
			<div className="mt-2 gap-2 flex flex-wrap items-center">
				{checkout.checkoutLink && status !== "PAID" && status !== "CLOSED" && (
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
					aria-label={t("refresh")}
					disabled={refresh.isPending || Boolean(payment.action)}
					loading={refresh.isPending}
					aria-busy={refresh.isPending}
					onClick={async () => {
						if (checking.current || payment.action) return;
						checking.current = true;
						try {
							const result = await refresh.mutateAsync({ checkoutIntentId: pending.data!.id });
							setResult({ id: checkout.id, status: result.status });
							await queryClient.invalidateQueries({ queryKey: orpc.payments.key() });
						} catch {
							setResult({ id: checkout.id, status: "UNKNOWN" });
						} finally {
							checking.current = false;
						}
					}}
				>
					{t(compact ? "check" : "refresh")}
				</Button>
				<a
					href={supportHref}
					target={config.supportEmail ? undefined : "_blank"}
					rel="noopener noreferrer"
					className="min-h-9 text-xs font-medium rounded inline-flex items-center underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2"
				>
					{t("support")}
				</a>
			</div>
			{status && (
				<output className="mt-2 text-xs leading-5 block text-muted-foreground" aria-live="polite">
					{t(status)}
				</output>
			)}
			{compact && (
				<details className="mt-2 text-xs leading-5">
					<summary className="cursor-pointer text-muted-foreground">{t("details")}</summary>
					{details}
				</details>
			)}
		</section>
	);
}
