"use client";

import { useSessionQuery } from "@auth/lib/api";
import { imagePassBalanceQueryKey } from "@media/lib/image-pass-query";
import { IMAGE_PASS_PUBLIC_OFFER } from "@repo/config/client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { useCheckoutStatePolling } from "../hooks/use-checkout-state-polling";
import { subscribeToCheckoutForeground } from "../lib/checkout-state-polling";
import {
	clearImagePassCheckoutContext,
	saveImagePassCheckoutContext,
} from "../lib/image-pass-checkout-context";

export function ImagePassCheckoutReturnContent({
	intentId,
	providerOrderId,
	canceled = false,
	approved = false,
}: {
	intentId: string;
	providerOrderId?: string;
	canceled?: boolean;
	approved?: boolean;
}) {
	const t = useTranslations("imagePass");
	const session = useSessionQuery();
	const ownerId = session.data?.user?.isAnonymous !== true ? session.data?.user?.id : undefined;
	const queryClient = useQueryClient();
	const capture = useMutation(orpc.payments.capturePayPalImagePassCheckout.mutationOptions());
	const [captureFailed, setCaptureFailed] = useState(false);
	const started = useRef<string | null>(null);
	const capturing = useRef<string | null>(null);
	const captured = useRef<string | null>(null);
	const currentKey = useRef<string | null>(null);
	const mounted = useRef(true);
	const key =
		ownerId && providerOrderId && !canceled ? `${ownerId}:${intentId}:${providerOrderId}` : null;
	currentKey.current = key;
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const polling = useCheckoutStatePolling(
		ownerId ? JSON.stringify([ownerId, intentId]) : null,
		1_500,
	);
	const state = useQuery({
		...orpc.payments.getImagePassCheckoutState.queryOptions({ input: { intentId } }),
		queryKey: ["image-pass-checkout", ownerId, intentId],
		enabled: Boolean(ownerId),
		refetchInterval: polling.refetchInterval,
	});
	const refreshState = state.refetch;
	useEffect(
		() =>
			subscribeToCheckoutForeground(() => {
				if (!ownerId) return;
				polling.restart();
				void refreshState();
			}),
		[ownerId, polling, refreshState],
	);
	const status = state.data?.status;
	const mayCapture = Boolean(key && !canceled && state.isSuccess && status === "PENDING");
	async function capturePayment() {
		if (
			!mayCapture ||
			!key ||
			!providerOrderId ||
			capturing.current === key ||
			captured.current === key
		)
			return;
		capturing.current = key;
		setCaptureFailed(false);
		try {
			await capture.mutateAsync({ intentId, providerOrderId });
			if (!mounted.current || currentKey.current !== key) return;
			captured.current = key;
			polling.restart();
			await state.refetch();
		} catch {
			if (mounted.current && currentKey.current === key && captured.current !== key)
				setCaptureFailed(true);
		} finally {
			if (capturing.current === key) capturing.current = null;
		}
	}
	useEffect(() => {
		if (!approved || !mayCapture || !key || started.current === key) return;
		started.current = key;
		void capturePayment();
	}, [key, mayCapture, approved]); // oxlint-disable-line eslint-plugin-react-hooks/exhaustive-deps

	const completed = state.isSuccess && status === "COMPLETED";
	useEffect(() => {
		if (!ownerId) return;
		if (
			state.isSuccess &&
			(status === "COMPLETED" || status === "EXPIRED" || status === "CANCELED")
		)
			clearImagePassCheckoutContext(ownerId, intentId);
		else if (state.isSuccess) saveImagePassCheckoutContext(ownerId, intentId);
		if (completed)
			void queryClient.invalidateQueries({
				queryKey: imagePassBalanceQueryKey(ownerId),
				exact: true,
			});
	}, [completed, ownerId, intentId, status, state.isSuccess, queryClient]);
	const recover =
		captureFailed ||
		state.isError ||
		status === "REVIEW" ||
		status === "EXPIRED" ||
		status === "CANCELED";
	const message = state.isError
		? "checkoutStatusError"
		: completed
			? "returnCompleted"
			: status === "REVIEW" || captureFailed
				? "returnReview"
				: status === "EXPIRED" || status === "CANCELED"
					? "checkoutNotCompleted"
					: canceled || !providerOrderId
						? "checkoutUnconfirmed"
						: !approved
							? "returnAwaitingConfirmation"
							: "returnPending";
	return (
		<section
			data-testid="image-pass-checkout-status"
			data-status={state.isError ? "error" : (status ?? "loading")}
			className="max-w-lg p-7 mx-auto rounded-2xl border text-center"
			aria-labelledby="image-pass-return-title"
		>
			<h1 id="image-pass-return-title" className="text-2xl font-semibold">
				{t("returnTitle")}
			</h1>
			{!completed && !recover && approved && !canceled && providerOrderId && (
				<Loader2Icon
					className="mt-5 size-7 animate-spin text-violet-400 mx-auto"
					aria-hidden="true"
				/>
			)}
			<p className="mt-4 text-sm leading-6 text-muted-foreground" aria-live="polite">
				{t(message, {
					currency: IMAGE_PASS_PUBLIC_OFFER.currency,
					amount: IMAGE_PASS_PUBLIC_OFFER.amount,
				})}
			</p>
			<div className="mt-6 gap-3 flex flex-wrap justify-center">
				{mayCapture && (!approved || captureFailed) && (
					<button
						type="button"
						data-testid="image-pass-confirm-payment"
						onClick={() => void capturePayment()}
						className="min-h-11 px-5 text-sm font-semibold rounded-xl bg-primary text-primary-foreground"
					>
						{t("returnConfirmPayment", {
							currency: IMAGE_PASS_PUBLIC_OFFER.currency,
							amount: IMAGE_PASS_PUBLIC_OFFER.amount,
						})}
					</button>
				)}
				<Link
					href={
						completed
							? "/create"
							: `/image-pass?${canceled ? "canceled=1&" : ""}intentId=${encodeURIComponent(intentId)}`
					}
					className="min-h-11 px-5 text-sm font-semibold inline-flex items-center rounded-xl bg-primary text-primary-foreground"
				>
					{t(completed ? "continueGenerating" : "checkoutBack")}
				</Link>
				{!completed && (
					<button
						type="button"
						data-testid="image-pass-check-status"
						onClick={() => {
							polling.restart();
							void state.refetch();
						}}
						className="min-h-11 px-4 text-sm rounded-xl border"
					>
						{t("checkStatus")}
					</button>
				)}
			</div>
		</section>
	);
}
