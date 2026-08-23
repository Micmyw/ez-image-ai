"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useInfiniteQuery } from "@tanstack/react-query";

export function useAssets(kind?: "image" | "video") {
	return useInfiniteQuery({
		queryKey: ["media-assets", { kind }],
		queryFn: ({ pageParam }) => orpcClient.media.listAssets({ kind, cursor: pageParam, limit: 24 }),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (page) => page.nextCursor ?? undefined,
	});
}
