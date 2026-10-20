"use client";

import { useSessionQuery } from "@auth/lib/api";
import { imagePassBalanceQueryOptions } from "@media/lib/image-pass-query";
import { IMAGE_PASS_PUBLIC_OFFER } from "@repo/config/client";
import { orpc } from "@shared/lib/orpc-query-utils";
import {
	captureCheckoutTrigger,
	clearCheckoutTrigger,
	getCurrentCheckoutAttribution,
} from "@shared/lib/purchase-attribution";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ImageIcon, Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { usePaymentAction } from "../hooks/use-payment-action";
import {
	clearImagePassCheckoutContext,
	readImagePassCheckoutContext,
	saveImagePassCheckoutContext,
} from "../lib/image-pass-checkout-context";
import { imagePassOfferQueryOptions } from "../lib/image-pass-offer-query";

export function ImagePassPurchase({ intentId }: { intentId?: string; canceled?: boolean } = {}) {
	const t = useTranslations("imagePass");
	const session = useSessionQuery();
	const user = session.data?.user;
	const ownerId = user && user.isAnonymous !== true ? user.id : null;
	const offer = IMAGE_PASS_PUBLIC_OFFER;
	const payment = usePaymentAction();
	const currentPayment = useRef(payment);
	currentPayment.current = payment;
	const balance = useQuery(imagePassBalanceQueryOptions(ownerId));
	const refreshBalance = balance.refetch;
	const availability = useQuery(imagePassOfferQueryOptions());
	const offerAvailable =
		!availability.isError && !availability.isPending && availability.data?.available === true;
	const checkout = useMutation(orpc.payments.createImagePassCheckout.mutationOptions());
	const attempt = useRef<{ ownerId: string; key: string } | null>(null);
	const pending = useRef(false);
	const ownedAction = useRef<ReturnType<typeof payment.getSnapshot>>(null);
	const currentOwner = useRef(ownerId);
	currentOwner.current = ownerId;
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			const action = currentPayment.current;
			if (ownedAction.current && action.getSnapshot() === ownedAction.current) action.release();
			ownedAction.current = null;
			pending.current = false;
		};
	}, [ownerId]);
	const [failed, setFailed] = useState(false);
	const [restored, setRestored] = useState<{ ownerId: string; intentId: string } | null>(null);
	const checkoutIntentId = restored?.ownerId === ownerId ? restored.intentId : intentId;
	useEffect(() => {
		if (!ownerId) {
			setRestored(null);
			return;
		}
		const savedIntent = intentId || readImagePassCheckoutContext(ownerId);
		setRestored(savedIntent ? { ownerId, intentId: savedIntent } : null);
	}, [ownerId, intentId]);
	const checkoutState = useQuery({
		...orpc.payments.getImagePassCheckoutState.queryOptions({
			input: { intentId: checkoutIntentId ?? "" },
		}),
		queryKey: ["image-pass-checkout", ownerId, checkoutIntentId],
		enabled: Boolean(ownerId && checkoutIntentId),
		refetchInterval: (query) => (query.state.data?.status === "PENDING" ? 3_000 : false),
	});
	const status = checkoutState.data?.status;
	const refreshCheckoutState = checkoutState.refetch;
	const completed = checkoutState.isSuccess && status === "COMPLETED";
	useEffect(() => {
		if (!ownerId || !checkoutIntentId || !checkoutState.isSuccess) return;
		if (status === "COMPLETED" || status === "EXPIRED" || status === "CANCELED")
			clearImagePassCheckoutContext(ownerId, checkoutIntentId);
		else saveImagePassCheckoutContext(ownerId, checkoutIntentId);
		if (completed) void refreshBalance();
	}, [ownerId, checkoutIntentId, status, checkoutState.isSuccess, completed, refreshBalance]);
	useEffect(() => {
		const restore = (event: Event) => {
			if (!ownerId) return;
			if (event.type === "pageshow" && (event as PageTransitionEvent).persisted)
				pending.current = false;
			const paymentAction = currentPayment.current;
			if (
				paymentAction.action?.key === "image-pass:paypal" &&
				paymentAction.action.stage === "redirecting"
			) {
				pending.current = false;
				paymentAction.release();
			}
			const savedIntent = readImagePassCheckoutContext(ownerId) || intentId;
			setRestored(savedIntent ? { ownerId, intentId: savedIntent } : null);
			if (savedIntent && savedIntent === checkoutIntentId) void refreshCheckoutState();
		};
		window.addEventListener("pageshow", restore);
		window.addEventListener("focus", restore);
		return () => {
			window.removeEventListener("pageshow", restore);
			window.removeEventListener("focus", restore);
		};
	}, [ownerId, intentId, checkoutIntentId, refreshCheckoutState]);
	const statusMessage = checkoutState.isError
		? "checkoutStatusError"
		: completed
			? "returnCompleted"
			: status === "REVIEW"
				? "returnReview"
				: status === "EXPIRED" || status === "CANCELED"
					? "checkoutNotCompleted"
					: "checkoutUnconfirmed";
	async function buy() {
		if (!ownerId || !offerAvailable || pending.current || !payment.acquire("image-pass:paypal"))
			return;
		const action = payment.getSnapshot();
		ownedAction.current = action;
		pending.current = true;
		const isCurrent = () =>
			mounted.current &&
			currentOwner.current === ownerId &&
			ownedAction.current === action &&
			payment.getSnapshot() === action;
		setFailed(false);
		if (attempt.current?.ownerId !== ownerId)
			attempt.current = { ownerId, key: crypto.randomUUID() };
		captureCheckoutTrigger();
		try {
			const attribution = await getCurrentCheckoutAttribution();
			if (!isCurrent()) return;
			const { checkoutLink, intentId: createdIntentId } = await checkout.mutateAsync({
				provider: "paypal",
				idempotencyKey: attempt.current.key,
				attribution,
			});
			if (!isCurrent()) return;
			clearCheckoutTrigger();
			saveImagePassCheckoutContext(ownerId, createdIntentId);
			setRestored({ ownerId, intentId: createdIntentId });
			attempt.current = null;
			try {
				const returnUrl = new URL(window.location.href);
				for (const key of ["intentId", "canceled", "approved", "token"])
					returnUrl.searchParams.delete(key);
				window.history.replaceState(
					window.history.state,
					"",
					`${returnUrl.pathname}${returnUrl.search}${returnUrl.hash}`,
				);
			} catch {
				// The new intent is already recoverable even if browser history cannot be updated.
			}
			payment.redirecting();
			window.location.assign(checkoutLink);
		} catch {
			if (isCurrent()) setFailed(true);
		} finally {
			if (payment.getSnapshot() === action) payment.release();
			if (ownedAction.current === action) {
				ownedAction.current = null;
				pending.current = false;
			}
		}
	}
	return (
		<section
			className="max-w-xl border-violet-300/20 p-6 text-white shadow-xl sm:p-9 mx-auto w-full rounded-3xl border bg-[#21182f]"
			aria-labelledby="image-pass-title"
		>
			<div className="mb-5 size-12 bg-violet-400/15 text-violet-200 flex items-center justify-center rounded-2xl">
				<ImageIcon aria-hidden="true" />
			</div>
			<p className="text-xs font-semibold tracking-widest text-violet-200 uppercase">
				{t("oneTime")}
			</p>
			<h1 id="image-pass-title" className="mt-2 text-3xl font-semibold tracking-tight">
				{t("title", { units: offer.units })}
			</h1>
			<p className="mt-3 text-4xl font-semibold">
				{offer.currency} {offer.amount}
			</p>
			<p className="mt-4 text-sm leading-6 text-[#d1c5df]">{t("description")}</p>
			<ul className="mt-5 space-y-3 text-sm leading-6 text-[#d1c5df]">
				{["models", "singleOutput", "separate", "repeat"].map((key) => (
					<li key={key}>✓ {t(key)}</li>
				))}
			</ul>
			{balance.data && (
				<div
					className="mt-5 gap-x-4 gap-y-1 text-sm text-violet-200 flex flex-wrap"
					data-test="image-pass-balance"
					aria-live="polite"
				>
					<span>{t("balance", { count: balance.data.available })}</span>
					{balance.data.reserved > 0 && (
						<span>{t("fundingReserved", { count: balance.data.reserved })}</span>
					)}
				</div>
			)}
			{ownerId && checkoutIntentId && (
				<div
					data-testid="image-pass-checkout-status"
					data-status={checkoutState.isError ? "error" : (status ?? "loading")}
					className="mt-6 border-violet-300/25 bg-violet-400/10 p-4 rounded-2xl border"
				>
					<h2 className="text-sm font-semibold text-violet-100">{t("checkoutStatusTitle")}</h2>
					<p className="mt-2 text-sm leading-6 text-[#d1c5df]" aria-live="polite">
						{t(statusMessage)}
					</p>
					<div className="mt-3 gap-3 flex flex-wrap items-center">
						{!completed && (
							<button
								type="button"
								data-testid="image-pass-check-status"
								onClick={() => void checkoutState.refetch()}
								disabled={checkoutState.isFetching}
								className="min-h-10 border-violet-300/30 px-3 text-sm text-violet-100 rounded-lg border disabled:opacity-60"
							>
								{t("checkStatus")}
							</button>
						)}
						<Link
							href="/create"
							className="min-h-10 text-sm text-violet-200 inline-flex items-center underline underline-offset-4"
						>
							{t("continueGenerating")}
						</Link>
					</div>
				</div>
			)}
			{!offerAvailable && (
				<p aria-live="polite" className="mt-5 text-sm text-[#d1c5df]">
					{availability.isPending ? t("availabilityLoading") : t("unavailable")}
				</p>
			)}
			{ownerId ? (
				<button
					type="button"
					data-testid="image-pass-buy"
					onClick={() => void buy()}
					disabled={!offerAvailable || Boolean(payment.action)}
					aria-busy={Boolean(payment.action?.key === "image-pass:paypal")}
					className="mt-7 min-h-12 gap-2 px-5 text-sm font-semibold hover:bg-white focus-visible:outline-violet-200 inline-flex w-full items-center justify-center rounded-xl bg-[#f5efff] text-[#34246f] focus-visible:outline-2 focus-visible:outline-offset-4 disabled:opacity-60"
				>
					{payment.action?.key === "image-pass:paypal" ? (
						<>
							<Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
							{t("processing")}
						</>
					) : checkoutIntentId && !completed ? (
						t("tryPurchaseAgain")
					) : (
						t("pay", { amount: offer.amount, currency: offer.currency })
					)}
				</button>
			) : !ownerId && offerAvailable ? (
				<Link
					href="/signup?redirectTo=%2Fimage-pass"
					className="mt-7 min-h-12 bg-white px-5 text-sm font-semibold inline-flex w-full items-center justify-center rounded-xl text-[#34246f]"
				>
					{t("signIn")}
				</Link>
			) : null}
			{failed && (
				<p role="alert" className="mt-3 text-sm leading-6 text-rose-200">
					{t("checkoutError")}
				</p>
			)}
			<p className="mt-4 text-xs leading-5 text-[#ad9ebc]">{t("fundingPolicy")}</p>
			<Link
				href="/create"
				className="mt-6 min-h-10 text-sm text-violet-200 inline-flex items-center underline underline-offset-4"
			>
				{t("back")}
			</Link>
		</section>
	);
}
