"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import {
	getJobPollingInterval,
	getJobPresentation,
	hasUnsettledJobCredits,
	reconcileJobSnapshot,
} from "../lib/job-status";
import { recordOutputReceived } from "../lib/preview-timing";

export function useJob(jobId: string | null) {
	const queryClient = useQueryClient();
	const refreshedSettlement = useRef<string | null>(null);
	const query = useQuery({
		queryKey: ["media-job", jobId],
		queryFn: async ({ signal }) => {
			const result = await orpcClient.media.getJob({ jobId: jobId! }, { signal });
			signal.throwIfAborted();
			const current = reconcileJobSnapshot(
				queryClient.getQueryData<typeof result>(["media-job", jobId]),
				result,
			);
			for (const asset of current.assets)
				recordOutputReceived(current.id, asset.id, current.requestId);
			return current;
		},
		enabled: Boolean(jobId),
		refetchInterval: (query) => {
			const status = query.state.data?.status ?? "RESERVED";
			return getJobPollingInterval({
				status,
				credits: query.state.data,
				hasReadyOutput: Boolean(query.state.data?.assets.length),
				isDocumentVisible:
					typeof document === "undefined" || document.visibilityState === "visible",
			});
		},
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
	}, [settlement, queryClient]);
	const accessDenied = ["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"].includes(
		(query.error as { code?: string } | null)?.code ?? "",
	);
	return { ...query, data: accessDenied ? undefined : query.data };
}
