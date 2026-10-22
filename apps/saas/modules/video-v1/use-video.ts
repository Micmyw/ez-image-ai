"use client";

import { useSession } from "@auth/hooks/use-session";
import { useJobEvents } from "@media/hooks/use-job-events";
import { usePageVisible } from "@media/hooks/use-page-visible";
import { useGenerationMode } from "@media/lib/generation-mode-context";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { videoApi } from "./api";
import { getVideoErrorKey, videoPollInterval } from "./model";

export { usePageVisible } from "@media/hooks/use-page-visible";

export function useVideoCatalog() {
	const { user } = useSession();
	const active = useGenerationMode()?.mode !== "image";
	const visible = usePageVisible();
	const queryClient = useQueryClient();
	const owner = user?.id;
	const enabled = Boolean(user && !user.isAnonymous) && active && visible;
	useEffect(() => {
		if (!enabled) return;
		const cache = queryClient.getQueryCache();
		return cache.subscribe((event) => {
			if (
				event.type !== "updated" ||
				(event.action.type !== "success" && event.action.type !== "invalidate") ||
				!cache.findAll({ queryKey: orpc.payments.key() }).includes(event.query)
			)
				return;
			void queryClient.invalidateQueries(
				{ queryKey: ["video-v1", "catalog", owner], exact: true },
				{ cancelRefetch: false },
			);
		});
	}, [enabled, owner, queryClient]);
	return useQuery({
		queryKey: ["video-v1", "catalog", owner],
		queryFn: () => videoApi.catalog(),
		enabled,
		staleTime: 0,
		refetchOnMount: "always",
		refetchOnWindowFocus: "always",
		// Observe external refunds while the page remains open; an earlier known
		// subscription/grace expiry shortens the next foreground refresh.
		refetchInterval: (query) => {
			if (!enabled) return false;
			const until = query.state.data?.pricingValidUntil;
			const remaining = until ? Date.parse(until) - Date.now() : 0;
			return remaining > 0 ? Math.min(30_000, remaining + 25) : 30_000;
		},
		refetchIntervalInBackground: false,
		retry: false,
	});
}

export function useVideoJob(jobId: string) {
	const { user } = useSession();
	const visible = usePageVisible();
	const active = useGenerationMode()?.mode !== "image";
	const queryKey = ["video-v1", "job", user?.id, jobId];
	const query = useQuery({
		queryKey,
		queryFn: ({ signal }) => videoApi.jobs.get({ jobId }, { signal }),
		enabled: Boolean(user && !user.isAnonymous && jobId) && active && visible,
		staleTime: 0,
		retry: false,
		refetchInterval: (query) =>
			query.state.error && getVideoErrorKey(query.state.error) === "unauthorized"
				? false
				: videoPollInterval(query.state.data?.stage, visible && active),
		refetchIntervalInBackground: false,
	});
	useJobEvents({
		jobId,
		ownerId: user?.id,
		queryKey,
		enabled:
			Boolean(user && !user.isAnonymous && jobId) &&
			active &&
			visible &&
			!(query.error && getVideoErrorKey(query.error) === "unauthorized") &&
			!["READY", "FAILED", "REJECTED"].includes(query.data?.stage ?? ""),
	});
	return query;
}
