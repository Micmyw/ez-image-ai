"use client";

import { useSessionQuery } from "@auth/lib/api";
import type { PlanId } from "@payments/types";
import { Spinner } from "@repo/ui/components/spinner";
import { saasGrowthFunnel } from "@shared/lib/growth-analytics";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { consumeVideoEffectPaymentReturn } from "../../video-effects/lib/payment-return";
import { checkoutReturnDestination, createChoosePlanPath } from "../lib/editor-upgrade";

const POLL_INTERVAL_MS = 2_000;
const POLL_WINDOW_MS = 120_000;

export function CheckoutReturnContent({
	organizationId,
	expectedPlanId,
	returnTo,
	checkoutIntentId,
	canceled = false,
	approved = false,
}: {
	organizationId?: string;
	expectedPlanId: PlanId;
	returnTo: string;
	checkoutIntentId?: string;
	canceled?: boolean;
	approved?: boolean;
}) {
	const t = useTranslations("checkoutReturn");
	const router = useRouter();
	const session = useSessionQuery();
	const user = session.data?.user;
	const ownerId = user && user.isAnonymous !== true ? user.id : null;
	const key =
		ownerId && checkoutIntentId ? `${ownerId}:${checkoutIntentId}:${expectedPlanId}` : null;
	const currentKey = useRef(key);
	currentKey.current = key;
	const mounted = useRef(true);
	const started = useRef<string | null>(null);
	const inFlight = useRef<string | null>(null);
	const tracked = useRef<string | null>(null);
	const pollingUntil = useRef(Date.now() + POLL_WINDOW_MS);
	const [failedKey, setFailedKey] = useState<string | null>(null);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const { mutateAsync: refreshCheckout, isPending: finishing } = useMutation(
		orpc.payments.refreshPendingSubscriptionCheckout.mutationOptions(),
	);
	const checkoutState = useQuery({
		...orpc.payments.getCheckoutReturnState.queryOptions({
			input: { organizationId, expectedPlanId, checkoutIntentId },
		}),
		queryKey: [
			"subscription-checkout-return",
			ownerId,
			organizationId ?? null,
			checkoutIntentId ?? null,
			expectedPlanId,
		],
		enabled: Boolean(key),
		refetchInterval: (query) =>
			Date.now() < pollingUntil.current &&
			(!query.state.data || query.state.data.status === "PENDING")
				? POLL_INTERVAL_MS
				: false,
	});
	const status = checkoutState.data?.status;
	const confirmed = Boolean(key && checkoutState.isSuccess);
	const completed = confirmed && (status === "ACTIVE" || status === "PAST_DUE");
	const mayFinish = Boolean(key && !canceled && confirmed && status === "PENDING");
	const failed = key !== null && failedKey === key;
	async function finish() {
		if (!mayFinish || !key || !checkoutIntentId || inFlight.current === key) return;
		inFlight.current = key;
		setFailedKey(null);
		try {
			await refreshCheckout({ checkoutIntentId });
			if (!mounted.current || currentKey.current !== key) return;
			pollingUntil.current = Date.now() + POLL_WINDOW_MS;
			await checkoutState.refetch();
		} catch {
			if (mounted.current && currentKey.current === key) setFailedKey(key);
		} finally {
			if (inFlight.current === key) inFlight.current = null;
		}
	}
	useEffect(() => {
		if (!approved || !mayFinish || !key || started.current === key) return;
		started.current = key;
		void finish();
	}, [approved, mayFinish, key]); // oxlint-disable-line eslint-plugin-react-hooks/exhaustive-deps
	useEffect(() => {
		if (!completed || status !== "ACTIVE" || !key || tracked.current === key) return;
		tracked.current = key;
		void saasGrowthFunnel.subscriptionActivated(expectedPlanId).catch(() => undefined);
	}, [completed, status, expectedPlanId, key]);
	const message = checkoutState.isError
		? "error"
		: completed
			? status === "PAST_DUE"
				? "pastDue"
				: "completed"
			: canceled
				? "canceled"
				: confirmed && status === "REVIEW"
					? "review"
					: confirmed && (status === "CANCELED" || status === "EXPIRED")
						? "notCompleted"
						: failed
							? "error"
							: "pending";
	const continuation =
		checkoutReturnDestination(completed ? status : undefined, returnTo) ?? "/create";
	return (
		<section
			className="gap-4 py-6 flex flex-col items-center justify-center"
			data-testid="subscription-checkout-status"
			data-status={message === "error" ? "error" : confirmed ? status : "loading"}
		>
			{checkoutState.isPending && key && <Spinner className="size-8" />}
			<p
				className="max-w-sm text-sm leading-6 text-center text-muted-foreground"
				aria-live="polite"
			>
				{t(message)}
			</p>
			{mayFinish && !approved && (
				<p className="max-w-sm text-xs leading-5 text-center text-muted-foreground">
					{t("finishHint")}
				</p>
			)}
			<div className="gap-3 flex flex-wrap items-center justify-center">
				{mayFinish && (!approved || failed) && (
					<button
						type="button"
						data-testid="subscription-confirm-payment"
						disabled={finishing}
						aria-busy={finishing}
						onClick={() => void finish()}
						className="min-h-11 px-4 text-sm font-semibold rounded-lg bg-primary text-primary-foreground disabled:opacity-60"
					>
						{t("finishApproved")}
					</button>
				)}
				{!completed && (
					<button
						type="button"
						data-testid="subscription-check-status"
						disabled={checkoutState.isFetching || !key}
						onClick={() => {
							pollingUntil.current = Date.now() + POLL_WINDOW_MS;
							void checkoutState.refetch();
						}}
						className="min-h-11 px-4 text-sm rounded-lg border disabled:opacity-60"
					>
						{t("checkStatus")}
					</button>
				)}
				<Link
					href={continuation}
					data-testid="subscription-continue"
					onClick={(event) => {
						if (!completed || !ownerId || currentKey.current !== key) return;
						const effectReturn = consumeVideoEffectPaymentReturn(ownerId, checkoutIntentId);
						if (effectReturn) {
							event.preventDefault();
							router.push(effectReturn);
						}
					}}
					className="min-h-11 px-4 text-sm font-semibold inline-flex items-center rounded-lg border"
				>
					{t("continueGenerating")}
				</Link>
				<Link
					href={createChoosePlanPath(returnTo)}
					data-testid="subscription-return-plans"
					className="min-h-11 px-4 text-sm inline-flex items-center underline underline-offset-4"
				>
					{t("returnToPlans")}
				</Link>
			</div>
		</section>
	);
}
