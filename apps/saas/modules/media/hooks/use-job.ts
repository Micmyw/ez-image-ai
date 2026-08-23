"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";

import { getJobPollingInterval } from "../lib/job-status";

export function useJob(jobId: string | null) {
	return useQuery({
		queryKey: ["media-job", jobId],
		queryFn: () => orpcClient.media.getJob({ jobId: jobId! }),
		enabled: Boolean(jobId),
		refetchInterval: (query) => {
			const status = query.state.data?.status ?? "RESERVED";
			return getJobPollingInterval({
				status,
				isDocumentVisible:
					typeof document === "undefined" || document.visibilityState === "visible",
			});
		},
		refetchOnWindowFocus: true,
	});
}
