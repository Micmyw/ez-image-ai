"use client";

import { PRODUCT_MODEL_KEYS } from "@repo/config/client";
import { orpcClient } from "@shared/lib/orpc-client";
import { infiniteQueryOptions, useInfiniteQuery } from "@tanstack/react-query";

import { getJobPresentation } from "../lib/job-status";

type ProductModelKey = (typeof PRODUCT_MODEL_KEYS)[number];

export function jobHistoryQueryOptions(filters: {
	status?: "active" | "succeeded" | "failed" | "canceled";
	productKey?: ProductModelKey;
}) {
	return infiniteQueryOptions({
		queryKey: ["media-jobs", filters],
		queryFn: ({ pageParam }) =>
			orpcClient.media.listJobs({ ...filters, cursor: pageParam, limit: 20 }),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (page) => page.nextCursor ?? undefined,
		refetchInterval: (query) =>
			query.state.data?.pages.some((page) =>
				page.items.some((job) => !getJobPresentation(job).terminal),
			)
				? 5_000
				: false,
	});
}

export function useJobHistory(filters: Parameters<typeof jobHistoryQueryOptions>[0]) {
	return useInfiniteQuery(jobHistoryQueryOptions(filters));
}
