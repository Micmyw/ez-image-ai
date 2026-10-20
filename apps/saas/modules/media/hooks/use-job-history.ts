"use client";

import { useSession } from "@auth/hooks/use-session";
import { PRODUCT_MODEL_KEYS } from "@repo/config/client";
import { orpcClient } from "@shared/lib/orpc-client";
import { infiniteQueryOptions, useInfiniteQuery } from "@tanstack/react-query";

import { useGenerationMode } from "../lib/generation-mode-context";
import { getJobPresentation, hasUnsettledJobCredits } from "../lib/job-status";
import { useActiveHistoryPolling } from "./use-active-history-polling";
import { usePageVisible } from "./use-page-visible";

type ProductModelKey = (typeof PRODUCT_MODEL_KEYS)[number];

export function jobHistoryQueryOptions(
	filters: {
		status?: "active" | "succeeded" | "failed" | "canceled";
		productKey?: ProductModelKey;
	},
	ownerId?: string,
) {
	return infiniteQueryOptions({
		queryKey: ["media-jobs", filters, ownerId],
		queryFn: ({ pageParam, signal }) =>
			orpcClient.media.listJobs({ ...filters, cursor: pageParam, limit: 20 }, { signal }),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (page) => page.nextCursor ?? undefined,
	});
}

export function useJobHistory(filters: Parameters<typeof jobHistoryQueryOptions>[0]) {
	const { user } = useSession();
	const active = useGenerationMode()?.mode !== "video";
	const visible = usePageVisible();
	const enabled = Boolean(user && !user.isAnonymous) && active;
	const options = jobHistoryQueryOptions(filters, user?.id);
	const history = useInfiniteQuery({ ...options, enabled });
	useActiveHistoryPolling({
		queryKey: options.queryKey,
		data: history.data,
		enabled: enabled && visible,
		interval: 5_000,
		getId: (item) => item.id,
		isActive: (item) => !getJobPresentation(item).terminal || hasUnsettledJobCredits(item),
		detailKey: (id) => ["media-history-job", user?.id, id],
		read: (jobId, signal) => orpcClient.media.getJob({ jobId }, { signal }),
		merge: (item, update) => {
			if (update.version < item.version) return item;
			if (
				filters.status === "active" &&
				["SUCCEEDED", "FAILED", "CANCELED"].includes(update.status)
			)
				return null;
			return {
				...item,
				status: update.status,
				version: update.version,
				creditsReserved: update.creditsReserved,
				creditsCharged: update.creditsCharged,
				creditsReleased: update.creditsReleased,
				outputCount: update.assets.length,
			};
		},
	});
	return history;
}
