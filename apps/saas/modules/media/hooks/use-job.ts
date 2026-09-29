"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import {
	getJobPollingInterval,
	getJobPresentation,
	hasUnsettledJobCredits,
} from "../lib/job-status";

export function useJob(jobId: string | null) {
	const queryClient = useQueryClient();
	const refreshedSettlement = useRef<string | null>(null);
	const query = useQuery({
		queryKey: ["media-job", jobId],
		queryFn: () => orpcClient.media.getJob({ jobId: jobId! }),
		enabled: Boolean(jobId),
		refetchInterval: (query) => {
			const status = query.state.data?.status ?? "RESERVED";
			return getJobPollingInterval({
				status,
				credits: query.state.data,
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
	return query;
}
