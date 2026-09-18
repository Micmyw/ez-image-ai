"use client";

import { config } from "@config";
import { cn } from "@repo/ui";
import { Button } from "@repo/ui/components/button";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { usePaymentAction } from "../hooks/use-payment-action";

export function PendingSubscriptionCheckout({ compact = false }: { compact?: boolean }) {
	const t = useTranslations("pricing.pendingCheckout");
	const pricing = useTranslations("pricing");
	const queryClient = useQueryClient();
	const payment = usePaymentAction();
	const busy = useRef(false);
	const checked = useRef({ id: "", at: 0 });
	const pollingUntil = useRef(Date.now() + 120_000);
	const [error, setError] = useState(false);
	const queryOptions = orpc.payments.getPendingSubscriptionCheckout.queryOptions({ input: {} });
	const pending = useQuery({
		...queryOptions,
		refetchInterval: (query) => {
			const current = query.state.data;
			if (!current || current.status === "REVIEW") return false;
			if (current.status === "WAITING") return 30_000;
			return Date.now() < pollingUntil.current ? 3_000 : false;
		},
	});
	const refresh = useMutation(orpc.payments.refreshPendingSubscriptionCheckout.mutationOptions());
	const cancel = useMutation(orpc.payments.cancelPendingSubscriptionCheckout.mutationOptions());
	const resume = useMutation(orpc.payments.resumePendingSubscriptionCheckout.mutationOptions());
	const refreshAsync = refresh.mutateAsync;
	const id = pending.data?.id;
	useEffect(() => {
		if (!id) return;
		const check = () => {
			if (
				document.visibilityState === "hidden" ||
				busy.current ||
				(checked.current.id === id && Date.now() - checked.current.at < 30_000)
			)
				return;
			checked.current = { id, at: Date.now() };
			pollingUntil.current = Date.now() + 120_000;
			void refreshAsync({ checkoutIntentId: id })
				.then(() => queryClient.invalidateQueries({ queryKey: orpc.payments.key() }))
				.catch(() => setError(true));
		};
		check();
		window.addEventListener("focus", check);
		window.addEventListener("pageshow", check);
		return () => {
			window.removeEventListener("focus", check);
			window.removeEventListener("pageshow", check);
		};
	}, [id, refreshAsync, queryClient]);
	if (!pending.data) return null;
	const checkout = pending.data;
	const provider = checkout.provider === "paypal" ? "PayPal" : "Waffo";
	const plan = ["creator", "ultimate", "studio"].includes(checkout.planId)
		? pricing(`products.${checkout.planId}.title`)
		: pricing("choosePlan");
	const period = checkout.interval === "year" ? pricing("yearly") : pricing("monthly");
	const supportHref = config.supportEmail
		? `mailto:${config.supportEmail}?subject=${encodeURIComponent(t("supportSubject", { id: checkout.id }))}&body=${encodeURIComponent(`${t("order", { id: checkout.id })}\n${plan} · ${period} · ${provider}`)}`
		: "/contact";
	const disabled =
		Boolean(payment.action) || refresh.isPending || cancel.isPending || resume.isPending;
	async function act(action: "resume" | "refresh" | "cancel") {
		if (busy.current || !payment.acquire(`pending-${action}`)) return;
		busy.current = true;
		setError(false);
		pollingUntil.current = Date.now() + 120_000;
		let redirecting = false;
		try {
			const input = { checkoutIntentId: checkout.id };
			if (action === "resume") {
				const result = await resume.mutateAsync(input);
				payment.redirecting();
				window.location.assign(result.checkoutLink);
				redirecting = true;
			} else {
				const result = await (action === "cancel"
					? cancel.mutateAsync(input)
					: refresh.mutateAsync(input));
				queryClient.setQueryData(queryOptions.queryKey, result.status === "CLOSED" ? null : result);
				await queryClient.invalidateQueries({ queryKey: orpc.payments.key() });
			}
		} catch {
			setError(true);
		} finally {
			busy.current = false;
			if (!redirecting) payment.release();
		}
	}
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
				{checkout.canResume && (
					<Button
						size="sm"
						disabled={disabled}
						loading={resume.isPending}
						onClick={() => void act("resume")}
					>
						{t("resume")}
					</Button>
				)}
				{checkout.canChange && (
					<Button
						size="sm"
						variant="outline"
						disabled={disabled}
						loading={cancel.isPending}
						onClick={() => void act("cancel")}
					>
						{t("changePlan")}
					</Button>
				)}
				<Button
					size="sm"
					variant="outline"
					aria-label={t("refresh")}
					disabled={disabled}
					loading={refresh.isPending}
					onClick={() => void act("refresh")}
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
			<output className="mt-2 text-xs leading-5 block text-muted-foreground" aria-live="polite">
				{t(error ? "UNKNOWN" : checkout.status)}
			</output>
			{checkout.waitUntil && checkout.status === "WAITING" && (
				<p className="mt-1 text-xs text-muted-foreground">
					<time dateTime={checkout.waitUntil}>
						{t("waitUntil", { date: new Date(checkout.waitUntil).toLocaleString() })}
					</time>
				</p>
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
