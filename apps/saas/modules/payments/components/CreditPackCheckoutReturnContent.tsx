"use client";

import { useSessionQuery } from "@auth/lib/api";
import { Spinner } from "@repo/ui/components/spinner";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CircleAlertIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { consumeVideoEffectPaymentReturn } from "../../video-effects/lib/payment-return";
import { clearCreditPackCheckoutContext } from "../lib/credit-pack-checkout-context";
import { getCreditPackCheckoutDestination } from "./checkout-attempt";

export function CreditPackCheckoutReturnContent({
	intentId,
	providerOrderId,
	approved = false,
	canceled = false,
}: {
	intentId: string;
	providerOrderId?: string;
	approved?: boolean;
	canceled?: boolean;
}) {
	const t = useTranslations("creditPackCheckoutReturn");
	const router = useRouter();
	const session = useSessionQuery();
	const user = session.data?.user;
	const ownerId = user && !user.isAnonymous ? user.id : undefined;
	const organizationId = session.data?.session?.activeOrganizationId ?? null;
	const scope = ownerId ? JSON.stringify([ownerId, organizationId, intentId]) : null;
	const key =
		scope && providerOrderId && !canceled ? JSON.stringify([scope, providerOrderId]) : null;
	const currentScope = useRef(scope);
	const currentKey = useRef(key);
	currentScope.current = scope;
	currentKey.current = key;
	const mounted = useRef(true);
	const started = useRef<string | null>(null);
	const capturing = useRef<string | null>(null);
	const captured = useRef<string | null>(null);
	const redirected = useRef<string | null>(null);
	const [failedKey, setFailedKey] = useState<string | null>(null);
	const [acceptedKey, setAcceptedKey] = useState<string | null>(null);
	const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const capture = useMutation(orpc.payments.capturePayPalCreditPackCheckout.mutationOptions());
	const checkoutState = useQuery({
		...orpc.payments.getCreditPackCheckoutState.queryOptions({ input: { intentId } }),
		queryKey: ["credit-pack-checkout", ownerId, organizationId, intentId],
		enabled: Boolean(ownerId && !session.isPending),
		refetchInterval: (query) =>
			query.state.status === "error"
				? false
				: !query.state.data || query.state.data.status === "PENDING"
					? 1_500
					: false,
	});
	const status = checkoutState.data?.status;
	const details =
		checkoutState.isSuccess &&
		checkoutState.data?.provider === "paypal" &&
		checkoutState.data.currency === "USD" &&
		/^\d+\.\d{2}$/.test(checkoutState.data.amount)
			? checkoutState.data
			: undefined;
	const mayCapture = Boolean(key && !canceled && status === "PENDING" && details);
	const captureFailed = Boolean(key && failedKey === key);
	const accepted = Boolean(key && acceptedKey === key);
	async function confirmPayment() {
		if (
			!mayCapture ||
			!key ||
			!providerOrderId ||
			capturing.current === key ||
			captured.current === key
		)
			return;
		capturing.current = key;
		setConfirmingKey(key);
		setFailedKey(null);
		try {
			await capture.mutateAsync({ intentId, providerOrderId });
			if (!mounted.current || currentKey.current !== key) return;
			captured.current = key;
			setAcceptedKey(key);
			await checkoutState.refetch();
		} catch {
			if (mounted.current && currentKey.current === key && captured.current !== key)
				setFailedKey(key);
		} finally {
			if (capturing.current === key) capturing.current = null;
			if (mounted.current && currentKey.current === key) setConfirmingKey(null);
		}
	}
	useEffect(() => {
		if (!approved || !mayCapture || !key || started.current === key) return;
		started.current = key;
		void confirmPayment();
	}, [approved, mayCapture, key]); // oxlint-disable-line eslint-plugin-react-hooks/exhaustive-deps
	const completed = Boolean(ownerId && checkoutState.isSuccess && status === "COMPLETED");
	useEffect(() => {
		if (
			!ownerId ||
			!scope ||
			!checkoutState.isSuccess ||
			!mounted.current ||
			currentScope.current !== scope
		)
			return;
		if (status === "COMPLETED" || status === "EXPIRED" || status === "CANCELED")
			clearCreditPackCheckoutContext(ownerId, organizationId, intentId);
		if (!completed || redirected.current === scope) return;
		const destination = getCreditPackCheckoutDestination(status);
		if (!destination) return;
		redirected.current = scope;
		router.replace(consumeVideoEffectPaymentReturn(ownerId, intentId) ?? destination);
	}, [
		completed,
		status,
		scope,
		ownerId,
		organizationId,
		intentId,
		checkoutState.isSuccess,
		router,
	]);
	const refreshState = checkoutState.refetch;
	useEffect(() => {
		const refresh = () => {
			if (ownerId) void refreshState();
		};
		window.addEventListener("pageshow", refresh);
		window.addEventListener("focus", refresh);
		return () => {
			window.removeEventListener("pageshow", refresh);
			window.removeEventListener("focus", refresh);
		};
	}, [ownerId, organizationId, intentId, refreshState]);
	const waitingConfirmation = mayCapture && !approved && !accepted && !captureFailed;
	const message = completed
		? t("completed")
		: checkoutState.isError || captureFailed
			? t("error")
			: status === "REVIEW"
				? t("review")
				: status === "EXPIRED" || status === "CANCELED"
					? t("notCompleted")
					: checkoutState.isPending
						? t("loading")
						: waitingConfirmation && details
							? t("awaitingConfirmation", { currency: details.currency, amount: details.amount })
							: t("pending");
	return (
		<div
			data-testid="credit-pack-checkout-status"
			data-status={checkoutState.isError ? "error" : (status ?? "loading")}
			className="gap-4 py-8 flex flex-col items-center justify-center"
		>
			{checkoutState.isPending ? (
				<Spinner className="size-8" />
			) : !completed ? (
				<span className="size-11 border-amber-500/25 bg-amber-500/10 inline-flex items-center justify-center rounded-full border">
					<CircleAlertIcon className="size-5 text-amber-600" aria-hidden="true" />
				</span>
			) : null}
			<p
				className="max-w-sm text-sm leading-6 text-center text-muted-foreground"
				aria-live="polite"
			>
				{message}
			</p>
			<div className="gap-2 flex w-full flex-wrap justify-center">
				{mayCapture && !accepted && (!approved || captureFailed) && details && (
					<button
						type="button"
						data-testid="credit-pack-confirm-payment"
						disabled={confirmingKey === key}
						aria-busy={confirmingKey === key}
						onClick={() => void confirmPayment()}
						className="min-h-10 px-4 text-sm font-semibold rounded-lg bg-primary text-primary-foreground disabled:opacity-60"
					>
						{t("confirmPayment", { currency: details.currency, amount: details.amount })}
					</button>
				)}
				{!completed && (
					<button
						type="button"
						data-testid="credit-pack-check-status"
						onClick={() => void checkoutState.refetch()}
						className="min-h-10 px-4 text-sm rounded-lg border"
					>
						{t("checkStatus")}
					</button>
				)}
				<Link
					href="/pricing"
					className="min-h-10 px-4 text-sm font-semibold inline-flex items-center justify-center rounded-lg bg-primary text-primary-foreground"
				>
					{t("tryAgain")}
				</Link>
				<Link
					href="/create"
					className="min-h-10 px-4 text-sm font-semibold inline-flex items-center justify-center rounded-lg border"
				>
					{t("returnToEditor")}
				</Link>
			</div>
		</div>
	);
}
