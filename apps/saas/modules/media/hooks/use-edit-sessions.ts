"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useInfiniteQuery } from "@tanstack/react-query";

export function useEditSessions() {
	return useInfiniteQuery({
		queryKey: ["media-edit-sessions"],
		queryFn: ({ pageParam }) => orpcClient.media.listEditSessions({ cursor: pageParam, limit: 20 }),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (page) => page.nextCursor ?? undefined,
	});
}
