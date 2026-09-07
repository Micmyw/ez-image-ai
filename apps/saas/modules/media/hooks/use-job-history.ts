"use client";

import { PRODUCT_MODEL_KEYS } from "@repo/config/client";
import { orpcClient } from "@shared/lib/orpc-client";
import { useInfiniteQuery } from "@tanstack/react-query";

type ProductModelKey = (typeof PRODUCT_MODEL_KEYS)[number];

export function useJobHistory(filters: {
	status?: "active" | "succeeded" | "failed" | "canceled";
	productKey?: ProductModelKey;
}) {
	return useInfiniteQuery({
		queryKey: ["media-jobs", filters],
		queryFn: ({ pageParam }) =>
			orpcClient.media.listJobs({ ...filters, cursor: pageParam, limit: 20 }),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (page) => page.nextCursor ?? undefined,
	});
}
