"use client";

import { useSession } from "@auth/hooks/use-session";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { useGenerationMode } from "../lib/generation-mode-context";
import {
	getJobPollingInterval,
	getJobPresentation,
	hasUnsettledJobCredits,
	reconcileJobSnapshot,
} from "../lib/job-status";
import { recordOutputReceived } from "../lib/preview-timing";
import { useJobEvents } from "./use-job-events";
import { usePageVisible } from "./use-page-visible";

export function useJob(jobId: string | null) {
	const queryClient = useQueryClient();
	const { user } = useSession();
	const queryKey = ["media-job", jobId, user?.id ?? null];
	const active = useGenerationMode()?.mode !== "video";
	const visible = usePageVisible();
	const refreshedSettlement = useRef<string | null>(null);
	const query = useQuery({
		queryKey,
		queryFn: async ({ signal }) => {
			const result = await orpcClient.media.getJob({ jobId: jobId! }, { signal });
			signal.throwIfAborted();
			const current = reconcileJobSnapshot(
				queryClient.getQueryData<typeof result>(queryKey),
				result,
			);
			for (const asset of current.assets)
				recordOutputReceived(current.id, asset.id, current.requestId);
			return current;
		},
		enabled: Boolean(jobId) && active && visible,
		refetchInterval: (query) => {
			if (!active || !visible) return false;
			const status = query.state.data?.status ?? "RESERVED";
			return getJobPollingInterval({
				status,
				credits: query.state.data,
				hasReadyOutput: Boolean(query.state.data?.assets.length),
				isDocumentVisible: visible,
			});
		},
		staleTime: 0,
		refetchIntervalInBackground: false,
		refetchOnWindowFocus: true,
	});
	const settlement =
		query.data && getJobPresentation(query.data).terminal && !hasUnsettledJobCredits(query.data)
			? `${jobId}:${query.data.creditsCharged}:${query.data.creditsReleased}`
			: null;
	useEffect(() => {
		if (!settlement || refreshedSettlement.current === settlement) return;
		refreshedSettlement.current = settlement;
		void queryClient.invalidateQueries({ queryKey: ["media-credit-account"] });
		void queryClient.invalidateQueries({ queryKey: ["media-image-pass-balance"] });
	}, [settlement, queryClient]);
	const accessDenied = ["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"].includes(
		(query.error as { code?: string } | null)?.code ?? "",
	);
	useJobEvents({
		jobId,
		ownerId: user?.id,
		queryKey,
		enabled:
			Boolean(user && !user.isAnonymous) && active && visible && !accessDenied && !settlement,
	});
	return { ...query, data: accessDenied ? undefined : query.data };
}
