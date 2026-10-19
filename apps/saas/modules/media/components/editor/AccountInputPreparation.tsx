"use client";

import { useSession } from "@auth/hooks/use-session";
import type { AccountInputCopyStatus } from "@repo/api/modules/media/lib/account-input-copy-status";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

export function AccountInputPreparation({
	draftId,
	ownerId,
	initialStatus,
}: {
	draftId: string;
	ownerId: string;
	initialStatus: AccountInputCopyStatus;
}) {
	const t = useTranslations("media.create.preparation");
	const router = useRouter();
	const { loaded, user } = useSession();
	const sameOwner = loaded && user?.id === ownerId;
	const [paused, setPaused] = useState(false);
	const refreshed = useRef(false);
	const initialPending = isPending(initialStatus.status);
	const query = useQuery({
		queryKey: ["media-account-input-copy", ownerId, draftId],
		queryFn: async ({ signal }) => {
			const status = await orpcClient.media.getAccountInputCopyStatus({ draftId }, { signal });
			signal.throwIfAborted();
			return status;
		},
		initialData: initialStatus,
		enabled: sameOwner && !paused && initialPending,
		staleTime: 0,
		gcTime: 0,
		retry: false,
		refetchOnMount: "always",
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
		refetchInterval: (query) =>
			sameOwner && !paused && !query.state.error && isPending(query.state.data?.status)
				? 3_000
				: false,
	});
	const denied = ["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"].includes(
		(query.error as { code?: string } | null)?.code ?? "",
	);
	const unavailable = (loaded && !sameOwner) || denied;
	const status = query.data?.status ?? initialStatus.status;

	useEffect(() => {
		if (paused || !sameOwner || !initialPending) return;
		const timer = setTimeout(() => setPaused(true), 120_000);
		return () => clearTimeout(timer);
	}, [paused, sameOwner, initialPending]);
	useEffect(() => {
		if (!sameOwner || query.isError || status !== "READY" || refreshed.current) return;
		refreshed.current = true;
		router.refresh();
	}, [sameOwner, query.isError, status, router]);

	const statusMessage = {
		COPYING: "copying",
		VERIFYING: "verifying",
		READY: "ready",
		FAILED: "failed",
		EXPIRED: "expired",
	} as const;
	const message = unavailable
		? "unavailable"
		: query.isError
			? "connectionError"
			: paused && isPending(status)
				? "paused"
				: statusMessage[status];
	return (
		<section
			className="max-w-2xl gap-4 p-6 mx-auto flex w-full flex-col rounded-2xl border"
			aria-labelledby="account-input-preparation-title"
			data-test="account-input-preparation"
		>
			<h2 id="account-input-preparation-title" className="text-lg font-semibold">
				{t("title")}
			</h2>
			<output aria-live="polite">{t(message)}</output>
			{!unavailable && <p className="text-sm text-muted-foreground">{t("saved")}</p>}
			<button
				type="button"
				className="min-h-11 px-4 text-sm font-medium self-start rounded-lg border disabled:opacity-50"
				disabled={!sameOwner || query.isFetching}
				onClick={async () => {
					if (!sameOwner) return;
					setPaused(false);
					await query.refetch();
				}}
			>
				{t(query.isFetching ? "checking" : "recheck")}
			</button>
			{!unavailable && (status === "FAILED" || status === "EXPIRED") && (
				<a
					className="text-sm self-start underline underline-offset-4"
					href="/create?draftError=unavailable"
				>
					{t("chooseAnother")}
				</a>
			)}
		</section>
	);
}

function isPending(status: AccountInputCopyStatus["status"] | undefined): boolean {
	return status === "COPYING" || status === "VERIFYING";
}
