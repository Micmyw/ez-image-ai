"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useInfiniteQuery } from "@tanstack/react-query";

export function useJobHistory(filters: {
	status?: "active" | "succeeded" | "failed" | "canceled";
	productKey?: "image-fast" | "image-quality" | "video-fast" | "video-quality";
}) {
	return useInfiniteQuery({
		queryKey: ["media-jobs", filters],
		queryFn: ({ pageParam }) =>
			orpcClient.media.listJobs({ ...filters, cursor: pageParam, limit: 20 }),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (page) => page.nextCursor ?? undefined,
	});
}
