"use client";

import { useSessionQuery } from "@auth/lib/api";
import { config } from "@config";
import { cn } from "@repo/ui";
import { Button } from "@repo/ui/components/button";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { usePaymentAction } from "../hooks/use-payment-action";
import { trackCheckoutStage } from "../lib/conversion";

export function PendingSubscriptionCheckout({ compact = false }: { compact?: boolean }) {
	const t = useTranslations("pricing.pendingCheckout");
	const checkoutReturn = useTranslations("checkoutReturn");
	const pricing = useTranslations("pricing");
	const session = useSessionQuery();
	const user = session.data?.user;
	const ownerId = user && user.isAnonymous !== true ? user.id : null;
	const currentOwner = useRef(ownerId);
	const queryClient = useQueryClient();
	const payment = usePaymentAction();
	const busy = useRef<string | null>(null);
	if (currentOwner.current !== ownerId) busy.current = null;
	currentOwner.current = ownerId;
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const pollingUntil = useRef(Date.now() + 120_000);
	const [error, setError] = useState(false);
	const queryOptions = {
		...orpc.payments.getPendingSubscriptionCheckout.queryOptions({ input: {} }),
		queryKey: ["pending-subscription-checkout", ownerId],
		enabled: Boolean(ownerId),
	};
	const pending = useQuery({
		...queryOptions,
		refetchInterval: (query) => {
			const current = query.state.data;
			if (!current) return false;
			// Read-only polling can observe an administrator's resolution without waking recovery.
			if (current.status === "REVIEW") return 30_000;
			if (current.status === "WAITING") return 30_000;
			return Date.now() < pollingUntil.current ? 3_000 : false;
		},
	});
	const refresh = useMutation(orpc.payments.refreshPendingSubscriptionCheckout.mutationOptions());
	const cancel = useMutation(orpc.payments.cancelPendingSubscriptionCheckout.mutationOptions());
	const resume = useMutation(orpc.payments.resumePendingSubscriptionCheckout.mutationOptions());
	const refetch = pending.refetch;
	const id = pending.data?.id;
	const currentIntent = useRef(id);
	currentIntent.current = id;
	useEffect(() => {
		if (!ownerId) return;
		const check = () => {
			if (document.visibilityState === "hidden") return;
			pollingUntil.current = Date.now() + 120_000;
			void refetch();
		};
		window.addEventListener("focus", check);
		window.addEventListener("pageshow", check);
		return () => {
			window.removeEventListener("focus", check);
			window.removeEventListener("pageshow", check);
		};
	}, [ownerId, refetch]);
	if (!ownerId || !pending.data) return null;
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
		Boolean(payment.action) ||
		pending.isFetching ||
		refresh.isPending ||
		cancel.isPending ||
		resume.isPending;
	async function act(action: "resume" | "finish" | "cancel") {
		const actionKey = `pending-${action}:${ownerId}:${checkout.id}`;
		if (busy.current || !payment.acquire(actionKey)) return;
		busy.current = actionKey;
		setError(false);
		pollingUntil.current = Date.now() + 120_000;
		let redirecting = false;
		try {
			const input = { checkoutIntentId: checkout.id };
			if (action === "resume") {
				trackCheckoutStage("purchase_clicked", "PLAN");
				trackCheckoutStage("checkout_requested", "PLAN");
				const result = await resume.mutateAsync(input);
				if (
					!mounted.current ||
					currentOwner.current !== ownerId ||
					currentIntent.current !== checkout.id
				)
					return;
				payment.redirecting();
				trackCheckoutStage("checkout_redirected", "PLAN");
				window.location.assign(result.checkoutLink);
				redirecting = true;
			} else {
				const result = await (action === "cancel"
					? cancel.mutateAsync(input)
					: refresh.mutateAsync({ ...input, retryReview: true }));
				if (
					!mounted.current ||
					currentOwner.current !== ownerId ||
					currentIntent.current !== checkout.id
				)
					return;
				queryClient.setQueryData(queryOptions.queryKey, result.status === "CLOSED" ? null : result);
				await queryClient.invalidateQueries({ queryKey: orpc.payments.key() });
			}
		} catch (error) {
			if (action === "resume") trackCheckoutStage("checkout_failed", "PLAN", error);
			if (
				mounted.current &&
				currentOwner.current === ownerId &&
				currentIntent.current === checkout.id
			)
				setError(true);
		} finally {
			if (busy.current === actionKey) busy.current = null;
			if (!redirecting && payment.getSnapshot()?.key === actionKey) payment.release();
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
			data-testid="pending-subscription-checkout"
		>
			<p className="font-medium">{t("title")}</p>
			<p className="mt-1 text-xs text-muted-foreground">
				{plan} · {period} · {provider}
			</p>
			{!compact && details}
			<div className="mt-2 gap-2 flex flex-wrap items-center">
				{checkout.canResume && (
					<Button
						data-testid="pending-subscription-resume"
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
						data-testid="pending-subscription-change-plan"
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
					data-testid="pending-subscription-check-status"
					size="sm"
					variant="outline"
					aria-label={t("refresh")}
					disabled={disabled}
					loading={pending.isFetching}
					onClick={() => {
						setError(false);
						pollingUntil.current = Date.now() + 120_000;
						void refetch();
					}}
				>
					{t(compact ? "check" : "refresh")}
				</Button>
				{["PENDING", "APPROVED", "UNKNOWN", "REVIEW"].includes(checkout.status) && (
					<Button
						data-testid="pending-subscription-confirm-payment"
						size="sm"
						variant="outline"
						disabled={disabled}
						loading={refresh.isPending}
						onClick={() => void act("finish")}
					>
						{checkoutReturn("finishApproved")}
					</Button>
				)}
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
				{t(error || pending.isError ? "UNKNOWN" : checkout.status)}
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
