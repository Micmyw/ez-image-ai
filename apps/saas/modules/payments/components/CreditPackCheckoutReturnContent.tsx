"use client";

import { Spinner } from "@repo/ui/components/spinner";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CircleAlertIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import {
	getCreditPackCheckoutDestination,
	getPayPalCreditPackCaptureInput,
} from "./checkout-attempt";

const POLL_INTERVAL_MS = 1_500;

export function CreditPackCheckoutReturnContent({
	intentId,
	providerOrderId,
}: {
	intentId: string;
	providerOrderId?: string;
}) {
	const t = useTranslations("creditPackCheckoutReturn");
	const router = useRouter();
	const captureStarted = useRef(false);
	const [polling, setPolling] = useState(true);
	const [captureFailed, setCaptureFailed] = useState(false);
	const capture = useMutation(orpc.payments.capturePayPalCreditPackCheckout.mutationOptions());
	const checkoutState = useQuery({
		...orpc.payments.getCreditPackCheckoutState.queryOptions({ input: { intentId } }),
		refetchInterval: polling ? POLL_INTERVAL_MS : false,
	});

	useEffect(() => {
		const captureInput = getPayPalCreditPackCaptureInput(intentId, providerOrderId);
		if (!captureInput || captureStarted.current) return;

		captureStarted.current = true;
		void capture
			.mutateAsync(captureInput)
			.then(() => checkoutState.refetch())
			.catch(() => {
				setCaptureFailed(true);
				setPolling(false);
			});
	}, [capture, checkoutState, intentId, providerOrderId]);

	useEffect(() => {
		const status = checkoutState.data?.status;
		const destination = getCreditPackCheckoutDestination(status);
		if (destination) {
			setPolling(false);
			router.replace(destination);
			return;
		}
		if (status && status !== "PENDING") setPolling(false);
	}, [checkoutState.data?.status, router]);

	const status = checkoutState.data?.status;
	const failed = captureFailed || checkoutState.isError;
	const review = status === "REVIEW";
	const notCompleted = status === "EXPIRED" || status === "CANCELED";
	const message = failed
		? t("error")
		: review
			? t("review")
			: notCompleted
				? t("notCompleted")
				: status === "COMPLETED"
					? t("completed")
					: t("loading");
	const showRecovery = failed || review || notCompleted;

	return (
		<div className="gap-4 py-8 flex flex-col items-center justify-center">
			{showRecovery ? (
				<span className="size-11 border-amber-500/25 bg-amber-500/10 inline-flex items-center justify-center rounded-full border">
					<CircleAlertIcon className="size-5 text-amber-600" aria-hidden="true" />
				</span>
			) : (
				<Spinner className="size-8" />
			)}
			<p
				className="max-w-sm text-sm leading-6 text-center text-muted-foreground"
				aria-live="polite"
			>
				{message}
			</p>
			{showRecovery && (
				<div className="gap-2 sm:flex-row flex w-full flex-col">
					<Link
						href="/pricing"
						className="min-h-10 px-4 text-sm font-semibold inline-flex flex-1 items-center justify-center rounded-lg bg-primary text-primary-foreground"
					>
						{t("tryAgain")}
					</Link>
					<Link
						href="/create"
						className="min-h-10 px-4 text-sm font-semibold inline-flex flex-1 items-center justify-center rounded-lg border"
					>
						{t("returnToEditor")}
					</Link>
				</div>
			)}
		</div>
	);
}
