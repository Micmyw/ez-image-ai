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

export function ImagePassPurchase() {
	const t = useTranslations("imagePass");
	const session = useSessionQuery();
	const user = session.data?.user;
	const ownerId = user && user.isAnonymous !== true ? user.id : null;
	const offer = IMAGE_PASS_PUBLIC_OFFER;
	const payment = usePaymentAction();
	const balance = useQuery(imagePassBalanceQueryOptions(ownerId));
	const checkout = useMutation(orpc.payments.createImagePassCheckout.mutationOptions());
	const attempt = useRef<{ ownerId: string; key: string } | null>(null);
	const pending = useRef(false);
	const currentOwner = useRef(ownerId);
	currentOwner.current = ownerId;
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const [failed, setFailed] = useState(false);
	async function buy() {
		if (!ownerId || pending.current || !payment.acquire("image-pass:paypal")) return;
		pending.current = true;
		setFailed(false);
		if (attempt.current?.ownerId !== ownerId)
			attempt.current = { ownerId, key: crypto.randomUUID() };
		captureCheckoutTrigger();
		try {
			const { checkoutLink } = await checkout.mutateAsync({
				provider: "paypal",
				idempotencyKey: attempt.current.key,
				attribution: await getCurrentCheckoutAttribution(),
			});
			if (!mounted.current || currentOwner.current !== ownerId) {
				payment.release();
				return;
			}
			clearCheckoutTrigger();
			attempt.current = null;
			payment.redirecting();
			window.location.assign(checkoutLink);
		} catch {
			if (mounted.current && currentOwner.current === ownerId) setFailed(true);
			payment.release();
		} finally {
			pending.current = false;
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
				<p className="mt-5 text-sm text-violet-200" aria-live="polite">
					{t("balance", { count: balance.data.available })}
				</p>
			)}
			{ownerId ? (
				<button
					type="button"
					onClick={() => void buy()}
					disabled={Boolean(payment.action)}
					aria-busy={Boolean(payment.action?.key === "image-pass:paypal")}
					className="mt-7 min-h-12 gap-2 px-5 text-sm font-semibold hover:bg-white focus-visible:outline-violet-200 inline-flex w-full items-center justify-center rounded-xl bg-[#f5efff] text-[#34246f] focus-visible:outline-2 focus-visible:outline-offset-4 disabled:opacity-60"
				>
					{payment.action?.key === "image-pass:paypal" ? (
						<>
							<Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
							{t("processing")}
						</>
					) : (
						t("pay", { amount: offer.amount, currency: offer.currency })
					)}
				</button>
			) : (
				<Link
					href="/signup?redirectTo=%2Fimage-pass"
					className="mt-7 min-h-12 bg-white px-5 text-sm font-semibold inline-flex w-full items-center justify-center rounded-xl text-[#34246f]"
				>
					{t("signIn")}
				</Link>
			)}
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
