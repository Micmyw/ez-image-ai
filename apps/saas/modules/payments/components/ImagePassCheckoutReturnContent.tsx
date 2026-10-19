"use client";

import { useSessionQuery } from "@auth/lib/api";
import { imagePassBalanceQueryKey } from "@media/lib/image-pass-query";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

export function ImagePassCheckoutReturnContent({
	intentId,
	providerOrderId,
}: {
	intentId: string;
	providerOrderId?: string;
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
	const key = ownerId && providerOrderId ? `${ownerId}:${intentId}:${providerOrderId}` : null;
	currentKey.current = key;
	const state = useQuery({
		...orpc.payments.getImagePassCheckoutState.queryOptions({ input: { intentId } }),
		queryKey: ["image-pass-checkout", ownerId, intentId],
		enabled: Boolean(ownerId),
		refetchInterval: (query) =>
			!query.state.data || query.state.data.status === "PENDING" ? 1_500 : false,
	});
	async function capturePayment() {
		if (!key || !providerOrderId || capturing.current === key || captured.current === key) return;
		capturing.current = key;
		setCaptureFailed(false);
		try {
			await capture.mutateAsync({ intentId, providerOrderId });
			if (currentKey.current !== key) return;
			captured.current = key;
			await state.refetch();
		} catch {
			if (currentKey.current === key) setCaptureFailed(true);
		} finally {
			if (capturing.current === key) capturing.current = null;
		}
	}
	useEffect(() => {
		if (!key || started.current === key || (state.data?.status && state.data.status !== "PENDING"))
			return;
		started.current = key;
		void capturePayment();
	}, [key]); // oxlint-disable-line eslint-plugin-react-hooks/exhaustive-deps

	const status = state.data?.status;
	const completed = status === "COMPLETED";
	useEffect(() => {
		if (completed && ownerId)
			void queryClient.invalidateQueries({
				queryKey: imagePassBalanceQueryKey(ownerId),
				exact: true,
			});
	}, [completed, ownerId, queryClient]);
	const recover =
		captureFailed ||
		state.isError ||
		status === "REVIEW" ||
		status === "EXPIRED" ||
		status === "CANCELED";
	return (
		<section
			className="max-w-lg p-7 mx-auto rounded-2xl border text-center"
			aria-labelledby="image-pass-return-title"
		>
			<h1 id="image-pass-return-title" className="text-2xl font-semibold">
				{t("returnTitle")}
			</h1>
			{!completed && !recover && (
				<Loader2Icon
					className="mt-5 size-7 animate-spin text-violet-400 mx-auto"
					aria-hidden="true"
				/>
			)}
			<p className="mt-4 text-sm leading-6 text-muted-foreground" aria-live="polite">
				{t(completed ? "returnCompleted" : recover ? "returnReview" : "returnPending")}
			</p>
			<div className="mt-6 gap-3 flex flex-wrap justify-center">
				<Link
					href={completed ? "/create" : "/image-pass"}
					className="min-h-11 px-5 text-sm font-semibold inline-flex items-center rounded-xl bg-primary text-primary-foreground"
				>
					{t(completed ? "back" : "checkoutBack")}
				</Link>
				{recover && (
					<button
						type="button"
						onClick={() => {
							if (captureFailed) void capturePayment();
							else void state.refetch();
						}}
						className="min-h-11 px-4 text-sm rounded-xl border"
					>
						{t("checkAgain")}
					</button>
				)}
			</div>
		</section>
	);
}
